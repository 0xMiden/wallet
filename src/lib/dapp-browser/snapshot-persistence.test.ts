/* eslint-disable import/first */
/**
 * Tests for the parked-dApp snapshot persistence layer.
 *
 * The snapshot store writes base64 data URLs to the Capacitor Cache
 * directory, one file per session id. Tests drive `@capacitor/filesystem`
 * via a hand-rolled in-memory mock so we can assert path sanitization,
 * the `data:` prefix guard on read, the mkdir-on-write path, and the
 * best-effort delete on error.
 *
 * jest.mock is hoisted above imports at runtime — the `import/first`
 * rule doesn't know that, hence the disable above.
 */

type FSEntry = { data: string };
const fsStore: Record<string, FSEntry> = {};

const mockMkdir = jest.fn(async (_opts: { path: string }) => undefined);
const mockWriteFile = jest.fn(async ({ path, data }: { path: string; data: string }) => {
  fsStore[path] = { data };
});
const mockReadFile = jest.fn(async ({ path }: { path: string }) => {
  const entry = fsStore[path];
  if (!entry) throw new Error('ENOENT');
  return { data: entry.data };
});
const mockDeleteFile = jest.fn(async ({ path }: { path: string }) => {
  delete fsStore[path];
});
const mockRmdir = jest.fn(async ({ path }: { path: string }) => {
  for (const k of Object.keys(fsStore)) {
    if (k.startsWith(path + '/')) delete fsStore[k];
  }
});

const mockStat = jest.fn(async ({ path }: { path: string }) => {
  const entry = fsStore[path];
  if (!entry) throw new Error('ENOENT');
  return { size: new TextEncoder().encode(entry.data).byteLength, mtime: 100, type: 'file', uri: path };
});
const mockReaddir = jest.fn(async ({ path }: { path: string }) => ({
  files: Object.entries(fsStore)
    .filter(([name]) => name.startsWith(`${path}/`))
    .map(([name, entry]) => ({
      name: name.slice(path.length + 1),
      size: new TextEncoder().encode(entry.data).byteLength,
      mtime: 100,
      type: 'file',
      uri: name
    }))
}));

jest.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    stat: (opts: { path: string }) => mockStat(opts),
    readdir: (opts: { path: string }) => mockReaddir(opts),
    mkdir: (...args: unknown[]) => mockMkdir(...(args as [{ path: string }])),
    writeFile: (...args: unknown[]) => mockWriteFile(...(args as [{ path: string; data: string }])),
    readFile: (...args: unknown[]) => mockReadFile(...(args as [{ path: string }])),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...(args as [{ path: string }])),
    rmdir: (...args: unknown[]) => mockRmdir(...(args as [{ path: string }]))
  }
}));

import {
  clearAllSnapshotsFromDisk,
  readSnapshotFromDisk,
  removeSnapshotFromDisk,
  writeSnapshotToDisk
} from './snapshot-persistence';

const DIR = 'miden-dapp-snapshots';
const DATA_URL = 'data:image/jpeg;base64,AAAAAAAAA';

beforeEach(() => {
  for (const k of Object.keys(fsStore)) delete fsStore[k];
  mockMkdir.mockClear();
  mockWriteFile.mockClear();
  mockReadFile.mockClear();
  mockDeleteFile.mockClear();
  mockRmdir.mockClear();
});

describe('writeSnapshotToDisk', () => {
  it('creates the directory before writing', async () => {
    await writeSnapshotToDisk('dapp-abc', DATA_URL);
    expect(mockMkdir).toHaveBeenCalledWith(expect.objectContaining({ path: DIR, directory: 'CACHE', recursive: true }));
  });

  it('writes the data URL to the directory as UTF-8 text', async () => {
    await writeSnapshotToDisk('dapp-abc', DATA_URL);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `${DIR}/dapp-abc.txt`,
        data: DATA_URL,
        directory: 'CACHE',
        encoding: 'utf8'
      })
    );
  });

  it('swallows errors so park operations never fail on snapshot I/O', async () => {
    mockMkdir.mockRejectedValueOnce(new Error('mkdir denied'));
    mockWriteFile.mockRejectedValueOnce(new Error('write failed'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writeSnapshotToDisk('dapp-abc', DATA_URL)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  describe('path sanitization', () => {
    it('replaces path separators in the id with underscores', async () => {
      // Dots in filenames are fine (e.g. dapp-abc_123.v2) — the
      // sanitizer only strips path separators. Since the Capacitor
      // Filesystem API scopes writes to `directory: Cache` and treats
      // the argument as a filename within that directory, a literal
      // `..` segment (with no unescaped `/` beside it) can't traverse.
      await writeSnapshotToDisk('../etc/passwd', DATA_URL);
      const callArgs = mockWriteFile.mock.calls[0]![0];
      expect(callArgs.path).toBe(`${DIR}/.._etc_passwd.txt`);
      // There must be exactly one `/` in the path — the one separating
      // the snapshot directory from the filename. No additional
      // separators introduced by the id.
      const pathWithoutDir = callArgs.path.slice(DIR.length + 1);
      expect(pathWithoutDir).not.toContain('/');
    });

    it('keeps alphanumerics, dashes, underscores, and dots', async () => {
      await writeSnapshotToDisk('dapp-abc_123.v2', DATA_URL);
      const callArgs = mockWriteFile.mock.calls[0]![0];
      expect(callArgs.path).toBe(`${DIR}/dapp-abc_123.v2.txt`);
    });

    it('replaces slashes even in the middle of an id', async () => {
      await writeSnapshotToDisk('foo/bar', DATA_URL);
      const callArgs = mockWriteFile.mock.calls[0]![0];
      expect(callArgs.path).toBe(`${DIR}/foo_bar.txt`);
    });
  });
});

describe('readSnapshotFromDisk', () => {
  it('returns the data URL for a session that was previously written', async () => {
    await writeSnapshotToDisk('dapp-abc', DATA_URL);
    expect(await readSnapshotFromDisk('dapp-abc')).toBe(DATA_URL);
  });

  it('returns null when the file does not exist', async () => {
    expect(await readSnapshotFromDisk('nonexistent')).toBeNull();
  });

  it('returns null and deletes the file when the stored bytes are not a data: URL', async () => {
    // Simulate a legacy file with garbage content.
    fsStore[`${DIR}/legacy.txt`] = { data: 'not-a-dataurl' };
    expect(await readSnapshotFromDisk('legacy')).toBeNull();
    // Fire-and-forget delete — allow it to settle.
    await Promise.resolve();
    expect(mockDeleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: `${DIR}/legacy.txt` }));
  });

  it('returns null when the underlying filesystem read returns a non-string (web fallback)', async () => {
    fsStore[`${DIR}/blob.txt`] = { data: DATA_URL };
    mockReadFile.mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3]) as unknown as string });
    expect(await readSnapshotFromDisk('blob')).toBeNull();
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});

describe('removeSnapshotFromDisk', () => {
  it('deletes the file at the sanitized path', async () => {
    await writeSnapshotToDisk('dapp-abc', DATA_URL);
    await removeSnapshotFromDisk('dapp-abc');
    expect(mockDeleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${DIR}/dapp-abc.txt`, directory: 'CACHE' })
    );
    expect(fsStore[`${DIR}/dapp-abc.txt`]).toBeUndefined();
  });

  it('swallows errors when the file does not exist', async () => {
    mockDeleteFile.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(removeSnapshotFromDisk('ghost')).resolves.toBeUndefined();
  });
});

describe('clearAllSnapshotsFromDisk', () => {
  it('recursively removes the snapshot directory', async () => {
    await writeSnapshotToDisk('a', DATA_URL);
    await writeSnapshotToDisk('b', DATA_URL);
    await clearAllSnapshotsFromDisk();
    expect(mockRmdir).toHaveBeenCalledWith(expect.objectContaining({ path: DIR, directory: 'CACHE', recursive: true }));
  });

  it('swallows errors when the directory does not exist', async () => {
    mockRmdir.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(clearAllSnapshotsFromDisk()).resolves.toBeUndefined();
  });
});

describe('ordered snapshot mutations', () => {
  it('deletes after a write still awaiting mkdir and preserves another snapshot', async () => {
    await writeSnapshotToDisk('keep', DATA_URL);
    let release: () => void = () => {
      throw new Error('mkdir has not started');
    };
    let started: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const creating = new Promise<void>(resolve => {
      started = resolve;
    });
    mockMkdir.mockImplementationOnce(async () => {
      started();
      await gate;
    });
    const write = writeSnapshotToDisk('closed', DATA_URL);
    await creating;
    const close = removeSnapshotFromDisk('closed');
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([write, close]);
    expect(await readSnapshotFromDisk('closed')).toBeNull();
    expect(await readSnapshotFromDisk('keep')).toBe(DATA_URL);
  });

  it('runs clear-all after a native file write already in flight', async () => {
    let release: () => void = () => {
      throw new Error('write has not started');
    };
    let started: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const writing = new Promise<void>(resolve => {
      started = resolve;
    });
    mockWriteFile.mockImplementationOnce(async ({ path, data }) => {
      started();
      await gate;
      fsStore[path] = { data };
    });
    const write = writeSnapshotToDisk('closed', DATA_URL);
    await writing;
    const reset = clearAllSnapshotsFromDisk();
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([write, reset]);
    expect(await readSnapshotFromDisk('closed')).toBeNull();
    expect(Object.keys(fsStore)).toHaveLength(0);
  });
});

describe('Task5 cache mobile previews', () => {
  it('refuses an oversized UTF-8 preview before filesystem write', async () => {
    await writeSnapshotToDisk('dapp-oversized', `data:image/jpeg;base64,${'A'.repeat(524_288)}`);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(fsStore[`${DIR}/dapp-oversized.txt`]).toBeUndefined();
  });

  it('stats an oversized legacy preview before reading its body and removes only that owned file', async () => {
    fsStore[`${DIR}/dapp-large.txt`] = { data: `data:image/jpeg;base64,${'A'.repeat(524_288)}` };
    fsStore['unrelated.txt'] = { data: DATA_URL };
    await expect(readSnapshotFromDisk('dapp-large')).resolves.toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(fsStore[`${DIR}/dapp-large.txt`]).toBeUndefined();
    expect(fsStore['unrelated.txt']?.data).toBe(DATA_URL);
  });

  it('bounds orphan preview count and bytes while preserving unrelated files and the new preview', async () => {
    for (let index = 0; index < 8; index++) fsStore[`${DIR}/dapp-${index}.txt`] = { data: DATA_URL };
    fsStore[`${DIR}/0-unrelated.bin`] = { data: 'unrelated' };
    await writeSnapshotToDisk('dapp-new', DATA_URL);
    const owned = Object.entries(fsStore).filter(([name]) => name.startsWith(`${DIR}/`) && name.endsWith('.txt'));
    expect(owned.length).toBeLessThanOrEqual(8);
    expect(
      owned.reduce((total, [, entry]) => total + new TextEncoder().encode(entry.data).byteLength, 0)
    ).toBeLessThanOrEqual(4_194_304);
    expect(fsStore[`${DIR}/dapp-new.txt`]?.data).toBe(DATA_URL);
    expect(fsStore[`${DIR}/0-unrelated.bin`]?.data).toBe('unrelated');
  });

  it('a removal queued during an accepted delayed write leaves no orphan afterward', async () => {
    let finish!: () => void;
    mockWriteFile.mockImplementationOnce(async ({ path, data }) => {
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      fsStore[path] = { data };
    });
    const writing = writeSnapshotToDisk('dapp-closing', DATA_URL);
    await new Promise(resolve => setTimeout(resolve, 0));
    const removing = removeSnapshotFromDisk('dapp-closing');
    finish();
    await Promise.all([writing, removing]);
    expect(fsStore[`${DIR}/dapp-closing.txt`]).toBeUndefined();
  });
});
