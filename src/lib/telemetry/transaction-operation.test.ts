import { ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import { operationOfType, stepOfStage } from './transaction-operation';

describe('naming the operation a transaction row represents', () => {
  it.each<[ITransactionType, string]>([
    ['send', 'tx_send'],
    ['consume', 'tx_receive'],
    ['swap', 'tx_swap'],
    ['execute', 'tx_dapp']
  ])('maps %s onto %s', (type, operation) => {
    expect(operationOfType(type)).toBe(operation);
  });

  it('folds both directions of a bridge onto one name', () => {
    // The question worth asking of a bridge is whether bridging works, not
    // which way the money went — and either direction alone is too rare to read.
    expect(operationOfType('bridged-send')).toBe('tx_bridge');
    expect(operationOfType('bridged-receive')).toBe('tx_bridge');
  });

  it('folds every guardian operation onto one name', () => {
    const guardian: ITransactionType[] = ['switch-guardian', 'replace-hot-key', 'update-procedure-threshold'];
    expect(guardian.map(operationOfType)).toEqual(['tx_guardian', 'tx_guardian', 'tx_guardian']);
  });

  it('folds both halves of earn onto one name', () => {
    expect(operationOfType('earn-deposit')).toBe('tx_earn');
    expect(operationOfType('earn-withdraw')).toBe('tx_earn');
  });

  it('names a type it has never heard of rather than reporting nothing', () => {
    // Rows come back from IndexedDB, where a build that ran earlier — or later —
    // may have written a type this one does not know. The cast is the point: no
    // caller can reach this through the type system, and the wallet still has to
    // survive it.
    expect(operationOfType('teleport' as ITransactionType)).toBe('tx_other');
  });
});

describe('naming where a transaction died', () => {
  it('keeps proving distinct, because a prover failure is the reason this exists', () => {
    expect(stepOfStage('proving')).toBe('proving');
  });

  it('folds every stage that hands bytes to the network onto one name', () => {
    const submitting: ITransactionStage[] = ['sending', 'submitting', 'delivering'];
    expect(submitting.map(stepOfStage)).toEqual(['submitting', 'submitting', 'submitting']);
  });

  it('folds every stage that talks to the guardian onto one name', () => {
    const signing: ITransactionStage[] = [
      'creating-proposal',
      'signing-proposal',
      'registering-guardian',
      'guardian-syncing',
      'guardian-synced'
    ];
    expect(new Set(signing.map(stepOfStage))).toEqual(new Set(['signing']));
  });

  it('names no failure location for a row that finished', () => {
    // `complete` is not somewhere a transaction died, so there is nothing to
    // report. Sending `step: 'complete'` on a failure would be a contradiction.
    expect(stepOfStage('complete')).toBeUndefined();
  });

  it('names no failure location for a row that never recorded a stage', () => {
    expect(stepOfStage(undefined)).toBeUndefined();
  });

  it('resolves every stage the pipeline can record', () => {
    // The map is total, so this cannot fail by omission — it fails if somebody
    // adds a stage and maps it to `undefined` to make the typechecker quiet,
    // which would silently drop the most diagnostic field a failure carries.
    const stages: ITransactionStage[] = [
      'syncing',
      'sending',
      'creating-proposal',
      'signing-proposal',
      'executing',
      'proving',
      'submitting',
      'confirming',
      'registering-guardian',
      'delivering',
      'guardian-syncing',
      'guardian-synced'
    ];

    expect(stages.filter(stage => stepOfStage(stage) === undefined)).toEqual([]);
  });
});
