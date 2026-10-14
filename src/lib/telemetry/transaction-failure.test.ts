import { captureCrash } from './crash';
import { reportTransactionFailure } from './transaction-failure';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
});

it('reports the screenshot assertion as a fixed diagnostic instead of redacted numeric text', async () => {
  reportTransactionFailure({
    type: 'execute',
    stage: 'executing',
    delegateTransaction: true,
    error: new Error("Offscreen call 'newTransaction' failed: assertion failed with error code: 15404814807981965102"),
    diagnostics: { authPreparation: 'provided', authLayout: 'guardian', commitmentMatch: 'guardian' }
  });
  await settle();
  const [error, source, options] = jest.mocked(captureCrash).mock.calls[0]!;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe('WalletTransactionFailure');
  expect((error as Error).message).toContain('ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH');
  expect((error as Error).message).toContain('tx_dapp');
  expect((error as Error).message).toContain('executing');
  expect((error as Error).message).toContain('offscreen');
  expect((error as Error).message).toContain('guardian');
  expect(options).toEqual({ initializeIfNeeded: true });
  expect(source).toBe('manual');
});

it('does not forward unknown assertion codes, error text, or poisoned metadata', async () => {
  const poison = 'wallet-owner-password@example.org';
  reportTransactionFailure({
    type: poison,
    stage: poison,
    error: new Error(`assertion failed with error code: 99887766554433221100 ${poison}`),
    diagnostics: { authPreparation: poison, authLayout: poison, commitmentMatch: poison, request: poison }
  } as never);
  await settle();
  const [error] = jest.mocked(captureCrash).mock.calls[0]!;
  const text = `${(error as Error).message} ${(error as Error).stack}`;
  expect(text).not.toContain(poison);
  expect(text).not.toContain('99887766554433221100');
  expect(text).toContain('kernel_assertion_unknown');
  expect(text).toContain('tx_other');
});

it('distinguishes an unknown outcome from a final failure', async () => {
  reportTransactionFailure({ type: 'send', outcome: 'unconfirmed' });
  await settle();
  expect((jest.mocked(captureCrash).mock.calls[0]![0] as Error).message).toContain('unconfirmed');
});

it('does not confuse local proving with execution in the offscreen document', async () => {
  reportTransactionFailure({
    type: 'send',
    delegateTransaction: false,
    error: "Offscreen call 'sendTransaction' failed: advice stack read failed"
  });
  await settle();
  const error = jest.mocked(captureCrash).mock.calls[0]![0] as Error;
  expect(error.message).toContain('realm offscreen');
  expect(error.message).toContain('proving preference local');
});

it('never makes a telemetry failure escape into the transaction', async () => {
  jest.mocked(captureCrash).mockImplementationOnce(() => {
    throw new Error('Sentry unavailable');
  });
  expect(() => reportTransactionFailure({ type: 'swap' })).not.toThrow();
  await settle();
});
