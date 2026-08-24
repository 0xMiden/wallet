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

  it('reserves `submitting` for the node hand-off itself, and nothing after it', () => {
    // `submitting` is the only stage that IS the hand-off. `delivering` runs
    // after the transaction is on chain — it is the private-note transport relay
    // — so calling it `submitting` would report a transaction that committed as
    // one the node might have refused.
    expect(stepOfStage('submitting')).toBe('submitting');
    expect(stepOfStage('delivering')).toBe('confirming');
  });

  it('keeps `sending` out of the submitting bucket, because it is not one', () => {
    // The assertion that stops the headline signal being reported backwards.
    // Only a guardian transaction whose leaf ran inline ever stamps an explicit
    // `proving`; a non-guardian row is stamped `sending` once at pickup and runs
    // execute, prove AND submit under it, as does a guardian row whose leaf ran
    // offscreen — which is the default build. Folding it into `submitting` reads
    // as "the node refused it", so every prover outage on the wallet's commonest
    // transaction type would have been filed as a node problem.
    expect(stepOfStage('sending')).toBe('sending');
    expect(stepOfStage('sending')).not.toBe('submitting');
  });

  it('folds the guardian stages that run while BUILDING the transaction onto `signing`', () => {
    const building: ITransactionStage[] = ['creating-proposal', 'signing-proposal'];
    expect(new Set(building.map(stepOfStage))).toEqual(new Set(['signing']));
  });

  it('keeps the post-commit guardian stages out of `signing`, because the transaction already landed', () => {
    // The same defect as `sending` folding into `submitting`, pointing the other
    // way. `registering-guardian` is the re-registration that runs after the
    // transaction committed, and both `guardian-sync` stages sit in a block whose
    // own comment says the row is already Completed and the submit already
    // succeeded. Reported as `signing` — which the docs define as talking to the
    // guardian while BUILDING — a transaction that reached the chain and then
    // failed to tidy up would be indistinguishable from one never built at all.
    const afterCommit: ITransactionStage[] = ['registering-guardian', 'guardian-syncing', 'guardian-synced'];

    expect(new Set(afterCommit.map(stepOfStage))).toEqual(new Set(['confirming']));
    expect(afterCommit.map(stepOfStage)).not.toContain('signing');
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
