/** @jest-environment node */
import { planEpochRoundTrip } from '../playwright/e2e/helpers/mainnet-epoch-ui';
import { epochCheckpointFixture, epochForwardRequestAuthorityFixture } from './helpers/mainnet-epoch-fixture';

const candidate = () => ({ ...epochCheckpointFixture(), forwardMinimum: '1001000' });

it('budgets quote losses and native/shared-principal fees once, not the transferred principal', () => {
  const plan = planEpochRoundTrip(candidate(), 1_000_501n);
  expect(plan?.worstCaseCostUsdMicros).toBe(12_501n);
  expect(plan?.nativeFeesUsdMicros).toBe(3_000n);
});
it('refuses a route that fits $2 alone but exceeds the shared remaining allowance', () => {
  expect(() => planEpochRoundTrip({ ...candidate(), lossBudgetUsdMicros: '12500' }, 1_000_501n)).toThrow();
});
it.each([0n, 1_001_001n])('never funds an invalid or oversized reverse input %s', amount => {
  expect(() => planEpochRoundTrip(candidate(), amount)).toThrow();
});
it('does not treat an unconfirmed forward credit as available reverse principal', () => {
  expect(() => planEpochRoundTrip({ ...epochCheckpointFixture(), forwardReceived: '1001000' }, 1_000_501n)).toThrow();
});
it('uses settled receipt proceeds without charging already-paid fees a second time', () => {
  const hash = `0x${'a'.repeat(64)}`;
  const plan = planEpochRoundTrip(
    {
      ...epochCheckpointFixture(),
      phase: 'forward-settled',
      forwardNoteId: hash,
      forwardMidenTxId: hash,
      forwardAuthority: {
        minimumOutput: '1000001',
        bindingHash: hash,
        reclaimHeight: 7200,
        mandateReclaimHeight: 2200
      },
      forwardRequestAuthority: epochForwardRequestAuthorityFixture(hash, epochCheckpointFixture().createdAt),
      forwardEvmTxHash: hash,
      forwardReceived: '1001000',
      paidMidenFees: '266'
    },
    1_000_501n
  );
  expect(plan?.worstCaseCostUsdMicros).toBe(12_501n);
});
it('reserves gas from the same Miden balance as principal', () => {
  const state = candidate();
  expect(() =>
    planEpochRoundTrip({ ...state, native: { ...state.native, balance: state.principal } }, 1_000_501n)
  ).toThrow();
});
it('requires existing EVM gas rather than silently funding the signer', () => {
  const state = candidate();
  expect(() => planEpochRoundTrip({ ...state, evm: { ...state.evm, nativeBalance: '0' } }, 1_000_501n)).toThrow();
});
it('does not use a profitable quote to enlarge the shared loss allowance', () => {
  expect(() =>
    planEpochRoundTrip(
      { ...candidate(), forwardMinimum: '1020000', reverseMinimum: '1020000', lossBudgetUsdMicros: '2000' },
      1_000_501n
    )
  ).toThrow();
});
