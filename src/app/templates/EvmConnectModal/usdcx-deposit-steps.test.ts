import { usdcxDepositSteps } from './usdcx-deposit-steps';

const ARC_TESTNET = 5042002;
const BASE_SEPOLIA = 84532;
const HASH = `0x${'7'.repeat(64)}`;

const shape = (input: Parameters<typeof usdcxDepositSteps>[0]) =>
  usdcxDepositSteps(input).map(step => `${step.id}:${step.state}`);

describe('usdcxDepositSteps', () => {
  it('lists three steps for a direct xReserve deposit and walks them with the phase', () => {
    expect(shape({ sourceChainId: ARC_TESTNET, phase: 'submitting' })).toEqual([
      'source:active',
      'deposit-attested:pending',
      'minted:pending'
    ]);
    expect(shape({ sourceChainId: ARC_TESTNET, phase: 'delivering' })).toEqual([
      'source:complete',
      'deposit-attested:active',
      'minted:pending'
    ]);
    expect(shape({ sourceChainId: ARC_TESTNET, phase: 'ready' })).toEqual([
      'source:complete',
      'deposit-attested:complete',
      'minted:active'
    ]);
    expect(shape({ sourceChainId: ARC_TESTNET, phase: 'received' })).toEqual([
      'source:complete',
      'deposit-attested:complete',
      'minted:complete'
    ]);
  });

  it('names the deposit step by the source chain', () => {
    const [source] = usdcxDepositSteps({ sourceChainId: ARC_TESTNET, phase: 'delivering' });
    expect(source).toMatchObject({ labelKey: 'usdcxStepDeposited', network: 'Arc Testnet' });
  });

  it('adds the burn attestation and the execute for an executor-route deposit', () => {
    const base = { sourceChainId: BASE_SEPOLIA, phase: 'delivering' as const };
    expect(shape({ ...base, cctp: { sourceDomain: 6, forwarded: true } })).toEqual([
      'source:complete',
      'burn-attested:active',
      'execute:pending',
      'deposit-attested:pending',
      'minted:pending'
    ]);
    expect(shape({ ...base, cctp: { sourceDomain: 6, forwarded: true, forwardState: 'PENDING' } })).toEqual([
      'source:complete',
      'burn-attested:complete',
      'execute:active',
      'deposit-attested:pending',
      'minted:pending'
    ]);
    expect(shape({ ...base, cctp: { sourceDomain: 6, forwarded: true, executeTxHash: HASH } })).toEqual([
      'source:complete',
      'burn-attested:complete',
      'execute:complete',
      'deposit-attested:active',
      'minted:pending'
    ]);
    expect(
      shape({ ...base, phase: 'received', cctp: { sourceDomain: 6, forwarded: true, executeTxHash: HASH } })
    ).toEqual([
      'source:complete',
      'burn-attested:complete',
      'execute:complete',
      'deposit-attested:complete',
      'minted:complete'
    ]);
  });

  it('says who executes on Arc: Circle for a forwarded burn, the user otherwise or once Circle gave up', () => {
    const executeOf = (cctp: Parameters<typeof usdcxDepositSteps>[0]['cctp']) =>
      usdcxDepositSteps({ sourceChainId: BASE_SEPOLIA, phase: 'delivering', cctp }).find(step => step.id === 'execute');
    expect(executeOf({ sourceDomain: 6, forwarded: true })).toMatchObject({
      labelKey: 'usdcxStepCircleExecutes',
      network: 'Arc Testnet'
    });
    expect(executeOf({ sourceDomain: 6, forwarded: false, attestation: '0xab', message: '0x12' })).toMatchObject({
      labelKey: 'usdcxStepUserExecutes',
      state: 'active'
    });
    expect(executeOf({ sourceDomain: 6, forwarded: true, forwardState: 'FAILED' })).toMatchObject({
      labelKey: 'usdcxStepUserExecutes'
    });
  });

  it('marks the step a failed row was on as failed and the rest pending', () => {
    expect(shape({ sourceChainId: BASE_SEPOLIA, phase: 'failed', cctp: { sourceDomain: 6, forwarded: true } })).toEqual(
      ['source:complete', 'burn-attested:failed', 'execute:pending', 'deposit-attested:pending', 'minted:pending']
    );
    expect(shape({ sourceChainId: ARC_TESTNET, phase: 'failed' })).toEqual([
      'source:complete',
      'deposit-attested:failed',
      'minted:pending'
    ]);
  });

  it('copes with a legacy row that recorded no source chain', () => {
    expect(shape({ phase: 'delivering' })).toEqual(['source:complete', 'deposit-attested:active', 'minted:pending']);
  });
});
