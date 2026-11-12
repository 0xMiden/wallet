/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMainnetNearCheckpoint,
  loadMainnetNearCheckpoint,
  saveMainnetNearCheckpoint,
  type MainnetNearCheckpoint
} from '../playwright/e2e/helpers/mainnet-near-checkpoint';

import { nativeNearFixture as fixture, nativeNearQuote as quote } from './helpers/mainnet-near-fixture';

const hash = `0x${'a'.repeat(64)}`;
function complete(): MainnetNearCheckpoint {
  const state = fixture();
  return {
    ...state,
    phase: 'complete',
    forwardQuote: quote('mm1apeg8ae87qy4n52a2myu6kpk8c3y4mav', state.principal),
    sendAuthority: {
      nonce: '11111111-1111-4111-8111-111111111111',
      noteId: hash,
      sha256: '1'.repeat(64),
      canonicalSha256: '2'.repeat(64)
    },
    forwardMidenTxId: hash,
    forwardEvmTxHash: hash,
    forwardReceived: '1001000',
    reverseQuote: quote(`0x${'2'.repeat(40)}`, '1001000'),
    returnAmount: '1001000',
    evmNonceBefore: 0,
    returnValuation: {
      pricedAt: '2026-11-12T12:00:01.000Z',
      nativeUsdMicros: '1000000',
      tokenUsdMicros: '1000000',
      gasUsdMicros: '2000000000'
    },
    transactions: [{ kind: 'transfer', nonce: 0, hash, feeWei: '1000' }],
    paidMidenFees: '14',
    paidEvmFees: '1000',
    returnProviderTxId: `0x${'b'.repeat(64)}`,
    returnNoteId: `0x${'c'.repeat(64)}`,
    returnMidenTxId: `0x${'d'.repeat(64)}`,
    reverseReceived: '1000001',
    consumeAuthority: {
      nonce: '22222222-2222-4222-8222-222222222222',
      sha256: '3'.repeat(64),
      canonicalSha256: '4'.repeat(64)
    },
    realizedCostUsdMicros: '10014'
  };
}
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mainnet-near-checkpoint-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
it('retains the exact native principal, existing actors, frozen fee policy, original prices and remaining budget', () => {
  const state = fixture();
  expect(parseMainnetNearCheckpoint(state)).toEqual(state);
});
it('loads no fabricated state when absent and atomically preserves exact original authority on save/reload', () => {
  const path = join(directory, 'roundtrip.json');
  expect(loadMainnetNearCheckpoint(path)).toBeUndefined();
  const state = fixture();
  saveMainnetNearCheckpoint(path, state);
  expect(loadMainnetNearCheckpoint(path)).toEqual(state);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(state);
});
it('accepts only a fully receipted native round trip with actual EVM/native fees and consume fingerprints', () => {
  const state = complete();
  expect(parseMainnetNearCheckpoint(state)).toEqual(state);
});
it('records a genuinely receipted provider native refund as cancelled, never as a successful round trip', () => {
  const state = complete();
  state.phase = 'cancelled';
  state.paidEvmFees = '0';
  state.refunded = '1000000';
  delete state.forwardEvmTxHash;
  delete state.forwardReceived;
  delete state.reverseQuote;
  delete state.returnAmount;
  delete state.evmNonceBefore;
  delete state.returnValuation;
  delete state.transactions;
  delete state.reverseReceived;
  expect(parseMainnetNearCheckpoint(state)).toEqual(state);
});
it('retains original zero-spend authority without inventing a funded receipt', () => {
  const state = fixture();
  state.phase = 'unspent';
  expect(parseMainnetNearCheckpoint(state)).toEqual(state);
});
it('refuses an actual forward refund fee that would exceed the original remaining shared allowance', () => {
  const state = fixture();
  state.lossBudgetUsdMicros = '20000';
  state.forwardQuote = { ...quote('mm1apeg8ae87qy4n52a2myu6kpk8c3y4mav', state.principal), refundFee: '30000' };
  expect(() => parseMainnetNearCheckpoint(state)).toThrow();
});
it('never replaces a corrupt existing checkpoint with a fresh principal or budget', () => {
  const path = join(directory, 'roundtrip.json');
  writeFileSync(path, '{bad');
  expect(() => loadMainnetNearCheckpoint(path)).toThrow();
});
const invalid: [string, (state: MainnetNearCheckpoint) => void][] = [
  [
    'legacy unqualified schema',
    state => {
      Reflect.set(state, 'version', 1);
    }
  ],
  [
    'another network',
    state => {
      Reflect.set(state, 'network', 'testnet');
    }
  ],
  [
    'renewed authorization run',
    state => {
      state.authorizationRunId = '101';
    }
  ],
  [
    'profit-expanded loss cap',
    state => {
      state.lossBudgetUsdMicros = '2000001';
    }
  ],
  [
    'zero output floor',
    state => {
      state.reverseMinimum = '0';
    }
  ],
  [
    'non-native identity',
    state => {
      state.native.hex = '0x5cb79d29507d3ad17bb6dc60279e89';
    }
  ],
  [
    'mismatched catalog asset',
    state => {
      state.evmAssetId = 'nep141:other.near';
    }
  ],
  [
    'unfunded principal',
    state => {
      state.principal = '20000000';
    }
  ],
  [
    'unbounded native fee use',
    state => {
      state.paidMidenFees = '1001';
    }
  ],
  [
    'unbounded EVM fee use',
    state => {
      state.paidEvmFees = '1000000000001';
    }
  ],
  [
    'credentials in provider endpoint',
    state => {
      state.serviceUrl = 'https://secret@1click.chaindefuser.com';
    }
  ],
  [
    'private note bytes',
    state => {
      Reflect.set(state, 'noteBytes', [1, 2, 3]);
    }
  ],
  [
    'returned fee metadata as authority',
    state => {
      Reflect.set(state.feePolicy ?? {}, 'privateKey', 'not-authority');
    }
  ]
];
it.each(invalid)('refuses %s instead of creating spending authority', (_name, change) => {
  const state = fixture();
  change(state);
  expect(() => parseMainnetNearCheckpoint(state)).toThrow();
});
const incomplete: [string, (state: MainnetNearCheckpoint) => void][] = [
  [
    'no actual native send fingerprints',
    state => {
      delete state.sendAuthority;
    }
  ],
  [
    'no actual consume fingerprints',
    state => {
      delete state.consumeAuthority;
    }
  ],
  [
    'no actual native receipt',
    state => {
      delete state.returnMidenTxId;
    }
  ],
  [
    'no provider-correlated return',
    state => {
      delete state.returnProviderTxId;
    }
  ],
  [
    'reusing original sent note as provider return',
    state => {
      state.returnNoteId = state.sendAuthority?.noteId;
    }
  ],
  [
    'no EVM gas receipt',
    state => {
      state.transactions = [{ kind: 'transfer', nonce: 0, hash }];
    }
  ],
  [
    'native return below the original floor',
    state => {
      state.reverseReceived = '999999';
    }
  ],
  [
    'renewed return price facts',
    state => {
      if (state.returnValuation) state.returnValuation.tokenUsdMicros = '1';
    }
  ]
];
it.each(incomplete)('never calls %s a completed round trip', (_name, change) => {
  const state = complete();
  change(state);
  expect(() => parseMainnetNearCheckpoint(state)).toThrow();
});
