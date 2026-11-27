/** @jest-environment node */
import * as fs from 'fs';
import * as path from 'path';

import {
  holdEndsAt,
  HOLD_EDGE_SECONDS,
  judgePaybackSample,
  leadingAmount,
  ownClaimsOfNote,
  parseFillProgress,
  pendingListRendered,
  PEER_SWAP_PAYBACK_HOLD_SECONDS,
  sameFaucetId,
  statusName,
  type SyncNoteView,
  toSeenNoteIds,
  toSyncData
} from './multi-device-swap';

// The helper module also drives browsers. These tests read only its pure functions, so the
// browser-side modules are replaced and never load.
jest.mock('@playwright/test', () => ({ expect: jest.fn() }));
jest.mock('./multi-device', () => ({}));
jest.mock('./swap', () => ({}));
jest.mock('./swap-document', () => ({}));

const RECEIVED_AT = 1_800_000_000;

const payback = (overrides: Partial<SyncNoteView> = {}): SyncNoteView => ({
  id: '0xabc',
  faucetId: 'mtst1faucet',
  amount: '399800000',
  peerSwapPayback: true,
  receivedAt: RECEIVED_AT,
  hasMetadata: true,
  ownSwapOrderNote: false,
  ...overrides
});

describe('PEER_SWAP_PAYBACK_HOLD_SECONDS', () => {
  it('matches the product constant', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/lib/miden/swap/classification.ts'), 'utf8');
    const match = /export const PEER_SWAP_PAYBACK_HOLD_SECONDS = (\d+) \* (\d+);/.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match?.[1]) * Number(match?.[2])).toBe(PEER_SWAP_PAYBACK_HOLD_SECONDS);
  });
});

describe('sameFaucetId', () => {
  it('ignores case and a routing suffix', () => {
    expect(sameFaucetId('mtst1ABC_qruqqypuyph', 'mtst1abc')).toBe(true);
  });

  it('tells two faucets apart', () => {
    expect(sameFaucetId('mtst1abc', 'mtst1abd')).toBe(false);
  });

  it('never matches an empty id', () => {
    expect(sameFaucetId('', '')).toBe(false);
  });
});

describe('parseFillProgress', () => {
  it('reads a known fill', () => {
    expect(parseFillProgress('3.99 of 9.99 SWPB filled')).toEqual({ filled: '3.99', total: '9.99 SWPB' });
  });

  it('reads an unknown fill', () => {
    expect(parseFillProgress('- of 9.99 SWPB filled')).toEqual({ filled: '-', total: '9.99 SWPB' });
  });

  it('reads a receipt with no symbol', () => {
    expect(parseFillProgress('- of - filled')).toEqual({ filled: '-', total: '-' });
  });

  it('refuses other text', () => {
    expect(parseFillProgress('Filled')).toBeNull();
  });
});

describe('leadingAmount', () => {
  it('reads the number before the symbol', () => {
    expect(leadingAmount('9.99 SWPB')).toBe(9.99);
  });

  it('drops grouping commas', () => {
    expect(leadingAmount('1,000.5')).toBe(1000.5);
  });

  it('gives null for an unknown amount', () => {
    expect(leadingAmount('-')).toBeNull();
  });
});

describe('toSyncData', () => {
  it('reads the stored notes and their flags', () => {
    const view = toSyncData({
      accountPublicKey: 'mtst1account',
      notes: [
        {
          id: '0xabc',
          faucetId: 'mtst1faucet',
          amountBaseUnits: '10',
          peerSwapPayback: true,
          receivedAt: RECEIVED_AT,
          metadata: { symbol: 'SWPB', decimals: 8 }
        },
        { id: '0xdef', faucetId: 'mtst1other', amountBaseUnits: '5', swapOrder: { orderId: '1' } },
        { faucetId: 'no id' },
        'not a note'
      ]
    });
    expect(view.accountPublicKey).toBe('mtst1account');
    expect(view.notes).toEqual([
      {
        id: '0xabc',
        faucetId: 'mtst1faucet',
        amount: '10',
        peerSwapPayback: true,
        receivedAt: RECEIVED_AT,
        hasMetadata: true,
        ownSwapOrderNote: false
      },
      {
        id: '0xdef',
        faucetId: 'mtst1other',
        amount: '5',
        peerSwapPayback: false,
        receivedAt: undefined,
        hasMetadata: false,
        ownSwapOrderNote: true
      }
    ]);
  });

  it('reads malformed storage as no notes', () => {
    expect(toSyncData(undefined)).toEqual({ accountPublicKey: undefined, notes: [] });
    expect(toSyncData({ notes: 'x' })).toEqual({ accountPublicKey: undefined, notes: [] });
  });
});

describe('toSeenNoteIds', () => {
  it('keeps only string ids', () => {
    expect([...toSeenNoteIds(['0xa', 3, '0xb'])]).toEqual(['0xa', '0xb']);
  });

  it('reads a missing record as empty', () => {
    expect(toSeenNoteIds(undefined).size).toBe(0);
  });
});

describe('judgePaybackSample', () => {
  const insideHold = RECEIVED_AT + 60;
  const afterHold = holdEndsAt(RECEIVED_AT) + 1;

  it('accepts a held payback that is not listed and not seen', () => {
    expect(
      judgePaybackSample({
        note: payback(),
        listLive: true,
        listed: false,
        seen: false,
        ownClaimRowIds: [],
        nowSeconds: insideHold
      })
    ).toEqual({ held: true, violations: [] });
  });

  it('refuses a listed card inside the hold', () => {
    const verdict = judgePaybackSample({
      note: payback(),
      listLive: true,
      listed: true,
      seen: false,
      ownClaimRowIds: [],
      nowSeconds: insideHold
    });
    expect(verdict.violations).toEqual(['payback 0xabc is listed as a transfer to accept inside the hold']);
  });

  it('refuses a seen-note record inside the hold', () => {
    const verdict = judgePaybackSample({
      note: payback(),
      listLive: false,
      listed: false,
      seen: true,
      ownClaimRowIds: [],
      nowSeconds: insideHold
    });
    expect(verdict.violations).toEqual(['payback 0xabc is in the seen-note record inside the hold']);
  });

  it('allows the card and the record after the hold', () => {
    expect(
      judgePaybackSample({
        note: payback(),
        listLive: true,
        listed: true,
        seen: true,
        ownClaimRowIds: [],
        nowSeconds: afterHold
      })
    ).toEqual({ held: false, violations: [] });
  });

  it('makes no claim inside the edge margin of the hold end', () => {
    const verdict = judgePaybackSample({
      note: payback(),
      listLive: true,
      listed: true,
      seen: true,
      ownClaimRowIds: [],
      nowSeconds: holdEndsAt(RECEIVED_AT) - HOLD_EDGE_SECONDS + 1
    });
    expect(verdict).toEqual({ held: false, violations: [] });
  });

  it('refuses a payback with no peer flag or no receive time', () => {
    const verdict = judgePaybackSample({
      note: payback({ peerSwapPayback: false, receivedAt: undefined }),
      listLive: true,
      listed: false,
      seen: false,
      ownClaimRowIds: [],
      nowSeconds: insideHold
    });
    expect(verdict.violations).toEqual([
      'payback 0xabc is not flagged as a peer payback on this device',
      'payback 0xabc has no receive time, so the claim list does not hold it back'
    ]);
  });

  it('refuses a claim row of this device, also after the note left the list', () => {
    const verdict = judgePaybackSample({
      note: undefined,
      listLive: false,
      listed: false,
      seen: false,
      ownClaimRowIds: ['row-1'],
      nowSeconds: afterHold
    });
    expect(verdict.violations).toEqual(['this device made claim rows row-1 for a peer payback']);
  });
});

describe('ownClaimsOfNote', () => {
  it('leaves out restored rows and rows of other notes', () => {
    const claim = {
      status: statusName(2),
      swapOrderTxId: 'order-row',
      swapSettleKind: undefined,
      swapPaybackAmounts: {}
    };
    const ledger = {
      orders: [],
      claims: [
        { ...claim, id: 'own', noteIds: ['0xabc'], restoredFromBackup: false },
        { ...claim, id: 'restored', noteIds: ['0xabc'], restoredFromBackup: true },
        { ...claim, id: 'other', noteIds: ['0xdef'], restoredFromBackup: false }
      ]
    };
    expect(ownClaimsOfNote(ledger, '0xabc').map(row => row.id)).toEqual(['own']);
  });
});

describe('statusName', () => {
  it('names each transaction status and refuses others', () => {
    expect([0, 1, 2, 3, 4, 9].map(statusName)).toEqual([
      'Queued',
      'GeneratingTransaction',
      'Completed',
      'Failed',
      'Unconfirmed',
      undefined
    ]);
  });
});

describe('pendingListRendered', () => {
  const url = 'chrome-extension://id/fullpage.html#/history?filter=pending';

  it('takes a list that still fetches for no sample, even when its header shows', () => {
    expect(pendingListRendered({ url, viewButtons: 1, loadingBars: 1 })).toBe(false);
    expect(pendingListRendered({ url, viewButtons: 1, loadingBars: 0 })).toBe(true);
  });

  it('needs the Pending filter and the header', () => {
    const noFilter = 'chrome-extension://id/fullpage.html#/history';
    expect(pendingListRendered({ url: noFilter, viewButtons: 1, loadingBars: 0 })).toBe(false);
    expect(pendingListRendered({ url, viewButtons: 0, loadingBars: 0 })).toBe(false);
  });
});
