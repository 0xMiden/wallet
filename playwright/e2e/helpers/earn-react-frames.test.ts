/** @jest-environment node */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarizeEarnReactFrames } from './earn-react-frames';

const EXTENSION = 'a'.repeat(32);
const CHUNK = 'use-user-visible-error.abcdefgh.js';
let build: string;

beforeEach(() => {
  build = mkdtempSync(join(tmpdir(), 'earn-frames-'));
  mkdirSync(join(build, 'chunks'));
});
afterEach(() => rmSync(build, { recursive: true, force: true }));

function map(source = '../../src/app/layouts/Dialogs.tsx'): void {
  writeFileSync(
    join(build, 'chunks', `${CHUNK}.map`),
    JSON.stringify({
      version: 3,
      file: CHUNK,
      sources: [source],
      sourcesContent: ['private source must not leak'],
      names: [],
      mappings: 'AAAA;AACA'
    })
  );
}

const stack = (extension = EXTENSION, chunk = CHUNK) =>
  `Error: Minified React error #185\n    at mh (chrome-extension://${extension}/chunks/${chunk}:2:1)`;

it('maps 1-based stack positions to only static markers and deduplicates repeated frames', () => {
  map();
  const result = summarizeEarnReactFrames([stack(), stack()], EXTENSION, build);
  expect(result).toBe('Dialogs:2:1');
  expect(result).not.toMatch(/chrome-extension|private|src\/|abcdefgh|mh|error/i);
});

it('refuses different origins, non-chunk paths, unknown sources and untrusted build maps', () => {
  map();
  expect(summarizeEarnReactFrames([stack('b'.repeat(32))], EXTENSION, build)).toBe('unavailable');
  expect(summarizeEarnReactFrames([stack(EXTENSION, '../private.js')], EXTENSION, build)).toBe('unavailable');
  expect(summarizeEarnReactFrames([stack(EXTENSION, 'other.abcdefgh.js')], EXTENSION, build)).toBe('unavailable');
  map('../../src/private/WalletVault.ts');
  expect(summarizeEarnReactFrames([stack()], EXTENSION, build)).toBe('unavailable');
  rmSync(join(build, 'chunks', `${CHUNK}.map`));
  const outside = join(tmpdir(), `earn-frame-outside-${process.pid}.map`);
  try {
    writeFileSync(outside, JSON.stringify({ version: 3, mappings: 'AAAA' }));
    symlinkSync(outside, join(build, 'chunks', `${CHUNK}.map`));
    expect(summarizeEarnReactFrames([stack()], EXTENSION, build)).toBe('unavailable');
  } finally {
    rmSync(outside, { force: true });
  }
});

it('fails closed on absent, oversized or invalid maps, malformed positions and no #185', () => {
  expect(summarizeEarnReactFrames([stack()], EXTENSION, build)).toBe('unavailable');
  writeFileSync(join(build, 'chunks', `${CHUNK}.map`), 'x'.repeat(3_000_000));
  expect(summarizeEarnReactFrames([stack()], EXTENSION, build)).toBe('unavailable');
  map();
  expect(summarizeEarnReactFrames([stack().replace(':2:1)', ':0:1)')], EXTENSION, build)).toBe('unavailable');
  expect(summarizeEarnReactFrames([stack().replace('#185', '#186')], EXTENSION, build)).toBe('unavailable');
});
