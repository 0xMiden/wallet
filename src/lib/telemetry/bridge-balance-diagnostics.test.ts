import { annotateUiProducer, snapshotUiProducer, validateUiEvidence } from './ui-producer-diagnostics';

const branches = ['fast_usdc', 'circle_usdc', 'native', 'registered_erc20', 'unrecorded'];
const stages = [
  'configuration',
  'input_validation',
  'request_build',
  'request',
  'response_decode',
  'rpc_rejected',
  'value_decode',
  'unrecorded'
];

describe('closed bridge balance evidence', () => {
  it.each(branches)('keeps the owned %s branch on its displayed balance error', branch => {
    const evidence = {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: branch,
      bridgeBalanceStage: 'request'
    };
    const error = new Error('private error text must not become diagnostics');
    annotateUiProducer(error, 'raw_bridge_balance_failed', 'field', evidence);
    expect(snapshotUiProducer(error, 'raw_bridge_balance_failed', 'field')).toEqual({
      bridgeBalanceBranch: branch,
      bridgeBalanceStage: 'request'
    });
    expect(snapshotUiProducer(error, 'raw_bridge_balance_failed', 'notice')).toBeUndefined();
    expect(snapshotUiProducer(error, 'invalidAmount', 'field')).toBeUndefined();
  });

  it.each(stages)('retains the observed %s stage', stage => {
    expect(
      validateUiEvidence('raw_bridge_balance_failed', 'field', {
        kind: 'bridge_balance_read',
        bridgeBalanceBranch: 'circle_usdc',
        bridgeBalanceStage: stage
      })
    ).toEqual({
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'circle_usdc',
      bridgeBalanceStage: stage
    });
  });

  it.each([
    { kind: 'bridge_balance_read', bridgeBalanceBranch: 'circle_usdc' },
    { kind: 'bridge_balance_read', bridgeBalanceStage: 'request' },
    { kind: 'bridge_balance_read', bridgeBalanceBranch: 'private-address', bridgeBalanceStage: 'request' },
    { kind: 'bridge_balance_read', bridgeBalanceBranch: 'native', bridgeBalanceStage: 'private-message' },
    {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'native',
      bridgeBalanceStage: 'request',
      rawError: 'private transport text'
    }
  ])('drops incomplete or unknown evidence: %j', evidence => {
    expect(validateUiEvidence('raw_bridge_balance_failed', 'field', evidence)).toBeUndefined();
  });

  it('does not evaluate inherited or accessor-bearing evidence', () => {
    const read = jest.fn(() => 'native');
    const inherited: unknown = Object.create({
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'native',
      bridgeBalanceStage: 'request'
    });
    const accessor = Object.defineProperty(
      { kind: 'bridge_balance_read', bridgeBalanceStage: 'request' },
      'bridgeBalanceBranch',
      { get: read }
    );
    expect(validateUiEvidence('raw_bridge_balance_failed', 'field', inherited)).toBeUndefined();
    expect(validateUiEvidence('raw_bridge_balance_failed', 'field', accessor)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('contains a hostile descriptor trap and clears previously valid evidence on invalid replacement', () => {
    const error = new Error('private failure');
    annotateUiProducer(error, 'raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'native',
      bridgeBalanceStage: 'value_decode'
    });
    expect(snapshotUiProducer(error, 'raw_bridge_balance_failed', 'field')).toEqual({
      bridgeBalanceBranch: 'native',
      bridgeBalanceStage: 'value_decode'
    });
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('private trap');
        }
      }
    );
    expect(() => annotateUiProducer(error, 'raw_bridge_balance_failed', 'field', hostile)).not.toThrow();
    expect(snapshotUiProducer(error, 'raw_bridge_balance_failed', 'field')).toBeUndefined();
  });
});
