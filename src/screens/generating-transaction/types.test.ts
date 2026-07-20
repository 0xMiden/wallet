import type { ITransaction, ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import type {
  GeneratingTransactionPageProps,
  GeneratingTransactionProps,
  TransactionStepState,
  TransactionStep,
  TransactionHeroState,
  TransactionHeroIconProps,
  StatusIndicatorProps,
  TransactionStepRowProps
} from './types';

// The runtime surface of this module is empty: every export is either an
// `interface` or a `type` alias, all of which erase to nothing at runtime.
// Import the whole namespace as a *value* (not `import type`) so the compiled
// module is actually loaded and counted in coverage, then assert that it leaks
// no runtime members. The type-only shapes below are exercised structurally so
// this file doubles as living documentation of the generating-transaction
// contracts and locks them against accidental field renames/removals via the
// TS compiler at test-build time.
import * as generatingTransactionTypes from './types';

import { TRANSACTION_STEPS } from './constants';

describe('generating-transaction/types', () => {
  describe('module runtime surface', () => {
    it('exposes no runtime members (all exports are compile-time-only)', () => {
      expect(Object.keys(generatingTransactionTypes)).toEqual([]);
    });

    it('does not leak any of the type-only aliases/interfaces at runtime', () => {
      const asRecord = generatingTransactionTypes as Record<string, unknown>;
      expect(asRecord.GeneratingTransactionPageProps).toBeUndefined();
      expect(asRecord.GeneratingTransactionProps).toBeUndefined();
      expect(asRecord.TransactionStepState).toBeUndefined();
      expect(asRecord.TransactionStep).toBeUndefined();
      expect(asRecord.TransactionHeroState).toBeUndefined();
      expect(asRecord.TransactionHeroIconProps).toBeUndefined();
      expect(asRecord.StatusIndicatorProps).toBeUndefined();
      expect(asRecord.TransactionStepRowProps).toBeUndefined();
    });
  });

  describe('GeneratingTransactionPageProps shape round-trips', () => {
    it('accepts the full shape with keepOpen present', () => {
      const full: GeneratingTransactionPageProps = {
        txId: 'tx-123',
        keepOpen: true
      };
      expect(full.txId).toBe('tx-123');
      expect(full.keepOpen).toBe(true);
    });

    it('accepts the minimal shape with only the required txId', () => {
      const minimal: GeneratingTransactionPageProps = {
        txId: 'tx-456'
      };
      expect(minimal.txId).toBe('tx-456');
      expect(minimal.keepOpen).toBeUndefined();
    });
  });

  describe('GeneratingTransactionProps shape round-trips', () => {
    const baseTransaction = (overrides: Partial<ITransaction> = {}): ITransaction =>
      ({
        id: 'tx-1',
        type: 'send' as ITransactionType,
        accountId: 'acct',
        status: 0,
        initiatedAt: 0,
        displayIcon: 'SEND',
        ...overrides
      }) as ITransaction;

    it('accepts the full shape with every optional field present', () => {
      const onDoneClick = jest.fn();
      const onViewExplorer = jest.fn();

      const full: GeneratingTransactionProps = {
        onDoneClick,
        transactionComplete: true,
        hasErrors: false,
        keepOpen: true,
        activeStage: 'proving' as ITransactionStage,
        activeType: 'send' as ITransactionType,
        activeTransaction: baseTransaction({ id: 'active' }),
        completedTransaction: baseTransaction({ id: 'completed' }),
        completedTxHash: '0xdeadbeef',
        onViewExplorer
      };

      full.onDoneClick();
      full.onViewExplorer?.();

      expect(onDoneClick).toHaveBeenCalledTimes(1);
      expect(onViewExplorer).toHaveBeenCalledTimes(1);
      expect(full.transactionComplete).toBe(true);
      expect(full.hasErrors).toBe(false);
      expect(full.keepOpen).toBe(true);
      expect(full.activeStage).toBe('proving');
      expect(full.activeType).toBe('send');
      expect(full.activeTransaction?.id).toBe('active');
      expect(full.completedTransaction?.id).toBe('completed');
      expect(full.completedTxHash).toBe('0xdeadbeef');
    });

    it('accepts the minimal shape with only required fields', () => {
      const onDoneClick = jest.fn();

      const minimal: GeneratingTransactionProps = {
        onDoneClick,
        transactionComplete: false
      };

      expect(minimal.transactionComplete).toBe(false);
      expect(minimal.hasErrors).toBeUndefined();
      expect(minimal.keepOpen).toBeUndefined();
      expect(minimal.activeStage).toBeUndefined();
      expect(minimal.activeType).toBeUndefined();
      expect(minimal.activeTransaction).toBeUndefined();
      expect(minimal.completedTransaction).toBeUndefined();
      expect(minimal.completedTxHash).toBeUndefined();
      expect(minimal.onViewExplorer).toBeUndefined();
    });

    it('permits completedTxHash to be explicitly null', () => {
      const withNullHash: GeneratingTransactionProps = {
        onDoneClick: jest.fn(),
        transactionComplete: true,
        completedTxHash: null
      };
      expect(withNullHash.completedTxHash).toBeNull();
    });
  });

  describe('TransactionStepState union round-trips', () => {
    it('accepts every state and narrows exhaustively', () => {
      const complete: TransactionStepState = 'complete';
      const active: TransactionStepState = 'active';
      const pending: TransactionStepState = 'pending';
      const failed: TransactionStepState = 'failed';

      const states: TransactionStepState[] = [complete, active, pending, failed];

      const labels = states.map((state) => {
        switch (state) {
          case 'complete':
            return state;
          case 'active':
            return state;
          case 'pending':
            return state;
          case 'failed':
            return state;
          default: {
            // Exhaustiveness guard: unreachable if the union is fully handled.
            const never: never = state;
            return never;
          }
        }
      });

      expect(labels).toEqual(['complete', 'active', 'pending', 'failed']);
    });
  });

  describe('TransactionHeroState union round-trips', () => {
    it('accepts every hero state and narrows exhaustively', () => {
      const processing: TransactionHeroState = 'processing';
      const success: TransactionHeroState = 'success';
      const failed: TransactionHeroState = 'failed';

      const states: TransactionHeroState[] = [processing, success, failed];

      const labels = states.map((state) => {
        switch (state) {
          case 'processing':
            return state;
          case 'success':
            return state;
          case 'failed':
            return state;
          default: {
            const never: never = state;
            return never;
          }
        }
      });

      expect(labels).toEqual(['processing', 'success', 'failed']);
    });
  });

  describe('TransactionStep alias tracks the TRANSACTION_STEPS tuple', () => {
    it('accepts each entry of the const TRANSACTION_STEPS tuple', () => {
      // `TransactionStep` is `(typeof TRANSACTION_STEPS)[number]`, so each
      // runtime entry of the const tuple must satisfy the alias.
      const steps: TransactionStep[] = TRANSACTION_STEPS.map((step) => step);
      expect(steps).toHaveLength(TRANSACTION_STEPS.length);
      expect(steps.map((s) => s.id)).toEqual([
        'guardian-approving',
        'generating-proof',
        'submitting',
        'syncing-guardian'
      ]);
    });

    it('exposes id/labelKey/defaultLabel on each step', () => {
      const [first] = TRANSACTION_STEPS;
      const typed: TransactionStep = first;
      expect(typed.id).toBe('guardian-approving');
      expect(typed.labelKey).toBe('transactionStepGuardianApproved');
      expect(typed.defaultLabel).toBe('Guardian approved');
    });
  });

  describe('TransactionHeroIconProps shape round-trips', () => {
    it('carries the hero state', () => {
      const props: TransactionHeroIconProps = { state: 'processing' };
      expect(props.state).toBe('processing');
    });
  });

  describe('StatusIndicatorProps shape round-trips', () => {
    it('carries the step state', () => {
      const props: StatusIndicatorProps = { state: 'active' };
      expect(props.state).toBe('active');
    });
  });

  describe('TransactionStepRowProps shape round-trips', () => {
    it('accepts the full shape with optional label and meta present', () => {
      const full: TransactionStepRowProps = {
        step: TRANSACTION_STEPS[0],
        state: 'complete',
        isLast: false,
        label: 'Guardian approved',
        meta: '2 sec'
      };
      expect(full.step.id).toBe('guardian-approving');
      expect(full.state).toBe('complete');
      expect(full.isLast).toBe(false);
      expect(full.label).toBe('Guardian approved');
      expect(full.meta).toBe('2 sec');
    });

    it('accepts the minimal shape with optionals absent', () => {
      const minimal: TransactionStepRowProps = {
        step: TRANSACTION_STEPS[3],
        state: 'pending',
        isLast: true
      };
      expect(minimal.step.id).toBe('syncing-guardian');
      expect(minimal.isLast).toBe(true);
      expect(minimal.label).toBeUndefined();
      expect(minimal.meta).toBeUndefined();
    });
  });
});
