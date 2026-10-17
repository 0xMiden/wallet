import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { englishWordlist } from '@miden/hd-key';

import { captureCrash } from './crash';
import assertions from './protocol-assertions.json';
import { redactMessage } from './redact';
import { reportTransactionFailure } from './transaction-failure';
import packageJson from '../../../package.json';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));

const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIELD_MODULUS = 2n ** 64n - 2n ** 32n + 1n;
const SDK_SPEC = packageJson.dependencies['@miden-sdk/miden-sdk'];
// A linked SDK build is gated by its own workflow, as scripts/check-native-prover-pin.mjs skips it.
const describePinned = /^(file:|link:|portal:|git\+|https?:|github:)/.test(SDK_SPEC) ? describe.skip : describe;

interface AssertionSources {
  sdk: string;
  crates: Record<string, string>;
  sha256: string;
}

// Read inside each test, so a missing record fails the test rather than the collection.
const sources = (): AssertionSources =>
  JSON.parse(readFileSync(join(__dirname, 'protocol-assertions.sources.json'), 'utf8'));

// A crate's source path in a built wasm, as `miden-protocol-0.17.1/`.
const CRATE_PATH = /\b(miden(?:-[a-z][a-z0-9]*)+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\//g;

const builtFrom = (wasm: string): Map<string, string[]> => {
  const crates = new Map<string, string[]>();
  const text = readFileSync(join(REPO_ROOT, 'node_modules/@miden-sdk/miden-sdk/dist', wasm)).toString('latin1');
  for (const [, crate = '', version = ''] of text.matchAll(CRATE_PATH)) {
    const versions = crates.get(crate) ?? [];
    if (!versions.includes(version)) versions.push(version);
    crates.set(crate, versions);
  }
  return crates;
};

// Keyed on the SDK release like the native prover's drift exemptions: any SDK bump fails here until the table is
// regenerated from the crates that release ships (scripts/generate-protocol-assertions.mjs).
describePinned('the kernel assertion table pins the shipped SDK', () => {
  it('was read for the SDK release the wallet pins', () => {
    expect(sources().sdk).toBe(SDK_SPEC);
  });

  it.each(['st/assets/miden_client_web.wasm', 'mt/assets/miden_client_web.wasm'])(
    'was read from the crate versions the installed %s was built from',
    wasm => {
      const built = builtFrom(wasm);
      const recorded = Object.entries(sources().crates);
      expect(recorded.map(([crate]) => crate)).toEqual(
        expect.arrayContaining(['miden-protocol', 'miden-standards', 'miden-core-lib', 'miden-agglayer'])
      );
      for (const [crate, version] of recorded) expect([crate, built.get(crate)]).toEqual([crate, [version]]);
    }
  );
});

describe('the kernel assertion table', () => {
  it('holds only closed names, one per code, each under a canonical field element other than 0', () => {
    const entries = Object.entries(assertions);
    for (const [code, name] of entries) {
      expect(code).toMatch(/^[1-9]\d{0,19}$/);
      expect(BigInt(code)).toBeLessThan(FIELD_MODULUS);
      expect(name).toMatch(/^[A-Z][A-Z0-9_]{2,127}$/);
    }
    expect(new Set(entries.map(([, name]) => name)).size).toBe(entries.length);
  });

  // CI has no crate sources to regenerate the table from, so the digest the generator recorded is what ties the table to
  // the release and crates beside it: an edit of either without rerunning the generator fails here.
  it('is the table the generator wrote from the recorded sources', () => {
    const { sha256, ...read } = sources();
    const table = readFileSync(join(__dirname, 'protocol-assertions.json'), 'utf8');
    expect(createHash('sha256').update(JSON.stringify(read)).update(table).digest('hex')).toBe(sha256);
  });

  // The digit and encoded-token rules read a closed name too, so every name, published or coined, is checked the way it
  // reaches the wire: inside a report, with the report's closed set.
  it('sends every name inside a report unchanged through crash scrubbing', () => {
    const changed = Object.entries(assertions).filter(([code, name]) => {
      jest.mocked(captureCrash).mockClear();
      reportTransactionFailure({ type: 'execute', error: new Error(`assertion failed with error code: ${code}`) });
      const call = jest.mocked(captureCrash).mock.calls[0];
      const error = call?.[0];
      const message = error instanceof Error ? error.message : '';
      return (
        !message.includes(`; ${name}. `) || redactMessage(message, englishWordlist, call?.[2]?.closedNames) !== message
      );
    });
    expect(Object.keys(assertions).length).toBeGreaterThan(0);
    expect(changed).toEqual([]);
  });

  // Crash scrubbing blanks a report holding four wordlist words in a row, as a recovery phrase, and redacts four digits
  // in a row: a name coined from a message's words has to survive both.
  it('coins only names a report survives crash scrubbing with', () => {
    const coined = Object.values(assertions).filter(name => /^(PROTOCOL|STANDARDS|CORE_LIB|AGGLAYER)_/.test(name));
    const report = (name: string) =>
      'Transaction failed: tx_dapp; stage signing; signing step creating_proposal; realm unknown; proving preference ' +
      `delegated; platform ios; point pipeline; ${name}. authentication preparation provided; layout guardian`;
    expect(coined.length).toBeGreaterThan(0);
    expect(coined.filter(name => redactMessage(report(name), englishWordlist) !== report(name))).toEqual([]);
  });
});
