/** @jest-environment node */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeFileCaptureSession } from './native-file-session.mjs';

it('keeps the recorded trace when the browser cannot mark the end of capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wallet-native-trace-'));
  try {
    const file = join(root, 'browser-0001', 'browser.pftrace');
    await mkdir(join(root, 'browser-0001'));
    const save = jest.fn(() => writeFile(file, 'partial trace'));
    const close = jest.fn();
    const capture: NativeFileCaptureSession = Object.assign(Object.create(NativeFileCaptureSession.prototype), {
      root,
      wallet: 'A',
      verified: true,
      endedAt: 0,
      plan: { file },
      perfetto: { save, close }
    });

    await expect(capture.finish(false)).resolves.toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(readFile(file, 'utf8')).resolves.toBe('partial trace');
    expect(JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'))).toMatchObject({
      complete: false,
      partial: true,
      problem: 'Browser or workload closed with incomplete coverage'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
