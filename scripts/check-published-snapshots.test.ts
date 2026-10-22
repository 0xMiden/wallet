/**
 * @jest-environment node
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkPublishedSnapshots, snapshotPairs } from './check-published-snapshots.mjs';

const BASE = 'https://raw.example/list/main';
const sources = [{ dir: 'snap', base: BASE }];

const rootWithSnapshots = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'snapshots-'));
  mkdirSync(path.join(root, 'snap'));
  writeFileSync(path.join(root, 'snap/testnet.json'), '{"a":1}\n');
  writeFileSync(path.join(root, 'snap/devnet.json'), '{"b":2}\n');
  writeFileSync(path.join(root, 'snap/README.md'), 'not a snapshot');
  return root;
};

const arrayBufferOf = (text: string) => {
  const bytes = Buffer.from(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

// Serves `files` by URL; a number answers with that HTTP status, anything missing with 404.
const serving = (files: Record<string, string | number>) =>
  jest.fn(async (url: string) => {
    const body = files[url] ?? 404;
    return typeof body === 'number'
      ? { ok: false, status: body, arrayBuffer: async () => new ArrayBuffer(0) }
      : { ok: true, status: 200, arrayBuffer: async () => arrayBufferOf(body) };
  });

it('pairs every bundled JSON snapshot with its published URL', () => {
  expect(snapshotPairs(rootWithSnapshots(), sources)).toEqual([
    { file: 'snap/devnet.json', url: `${BASE}/devnet.json` },
    { file: 'snap/testnet.json', url: `${BASE}/testnet.json` }
  ]);
});

it('checks the token list and Explore snapshots the wallet bundles', () => {
  expect(snapshotPairs().map(pair => pair.url)).toEqual([
    'https://raw.githubusercontent.com/0xMiden/token-list/main/testnet.json',
    'https://raw.githubusercontent.com/0xMiden/wallet-explore/main/devnet.json',
    'https://raw.githubusercontent.com/0xMiden/wallet-explore/main/testnet.json'
  ]);
});

it('passes when every published copy matches byte for byte, asking past the cache', async () => {
  const fetchImpl = serving({ [`${BASE}/devnet.json`]: '{"b":2}\n', [`${BASE}/testnet.json`]: '{"a":1}\n' });
  await expect(checkPublishedSnapshots({ root: rootWithSnapshots(), sources, fetchImpl })).resolves.toEqual({
    ok: true,
    lines: [`✓ snap/devnet.json matches ${BASE}/devnet.json`, `✓ snap/testnet.json matches ${BASE}/testnet.json`]
  });
  expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/devnet.json`, { cache: 'no-store' });
});

it('fails on a single byte of difference, such as a missing final newline', async () => {
  const fetchImpl = serving({ [`${BASE}/devnet.json`]: '{"b":2}\n', [`${BASE}/testnet.json`]: '{"a":1}' });
  const { ok, lines } = await checkPublishedSnapshots({ root: rootWithSnapshots(), sources, fetchImpl });
  expect(ok).toBe(false);
  expect(lines[1]).toBe(`✗ snap/testnet.json differs from ${BASE}/testnet.json; copy the published file over it`);
});

it('fails when a published copy cannot be fetched', async () => {
  const fetchImpl = serving({ [`${BASE}/devnet.json`]: '{"b":2}\n' });
  const { ok, lines } = await checkPublishedSnapshots({ root: rootWithSnapshots(), sources, fetchImpl });
  expect(ok).toBe(false);
  expect(lines[1]).toBe(`✗ snap/testnet.json: could not fetch ${BASE}/testnet.json (HTTP 404)`);
});
