import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertMainnetOneClickMayStart,
  loadMainnetOneClickCheckpoint,
  saveMainnetOneClickCheckpoint,
  type MainnetOneClickCheckpoint
} from './mainnet-one-click-checkpoint';

describe('mainnet 1Click checkpoint', () => {
  it('round trips a sanitized checkpoint and blocks a second outbound loop while principal is in flight', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mainnet-one-click-'));
    const path = join(directory, 'round-trip.json');
    const checkpoint: MainnetOneClickCheckpoint = {
      version: 1,
      phase: 'forward-submitted',
      routeId: 'base:usdc',
      symbol: 'USDC',
      principalBaseUnits: '1000000',
      sourceRunId: '12345',
      forwardCorrelationId: 'forward-correlation',
      forwardTransactionId: 'miden-transaction-id',
      reverseCorrelationId: 'reverse-correlation',
      reverseEvmTransactionHash: `0x${'a'.repeat(64)}`,
      updatedAt: new Date().toISOString()
    };

    try {
      expect(() => assertMainnetOneClickMayStart(undefined)).not.toThrow();
      saveMainnetOneClickCheckpoint(path, checkpoint);
      const loaded = loadMainnetOneClickCheckpoint(path);
      expect(loaded?.phase).toBe('forward-submitted');
      expect(loaded?.sourceRunId).toBe('12345');
      expect(loaded?.forwardCorrelationId).toBe('forward-correlation');
      expect(loaded?.forwardTransactionId).toBe('miden-transaction-id');
      expect(loaded?.reverseCorrelationId).toBe('reverse-correlation');
      expect(loaded?.reverseEvmTransactionHash).toBe(`0x${'a'.repeat(64)}`);
      expect(() => assertMainnetOneClickMayStart(loaded)).toThrow('Resume or recover its existing principal');
      expect(() => assertMainnetOneClickMayStart({ ...checkpoint, phase: 'execution-authorized' })).toThrow('Resume or recover its existing principal');
      expect(() => assertMainnetOneClickMayStart({ ...checkpoint, phase: 'complete' })).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
