/** @jest-environment node */
let mockJourney: (fixtures: unknown) => Promise<void>;
const mockBalance = jest.fn(async () => {});
const mockTest = Object.assign(
  (name: string, callback: typeof mockJourney) => {
    if (name.startsWith('recovering in place')) mockJourney = callback;
  },
  { describe: (_name: string, callback: () => void) => callback(), setTimeout: () => {} }
);

jest.mock('../fixtures/two-wallets', () => ({
  test: mockTest,
  expect: (value: unknown) => ({ toBe: (expected: unknown) => expect(value).toBe(expected) })
}));
jest.mock('../config/environments', () => ({ getEnvironmentConfig: () => ({ guardianUrl: 'https://guardian.test' }) }));
jest.mock('./balance-truth', () => ({
  waitForPendingNoteTotal: async () => {},
  waitForVaultBalance: () => mockBalance()
}));
jest.mock('./forgot-password', () => ({}));

beforeAll(async () => {
  await import('../tests/guardian-forgot-password.spec');
});

function fixture(settle: () => Promise<void>) {
  const events: string[] = [];
  const stopped = new Error('reset reached');
  const wallet = {
    page: {},
    trackGuardianCommitments: () => events.push('track'),
    createGuardianWallet: async () => {
      events.push('create');
      return { address: 'test-account', seedPhrase: Array(12).fill('test') };
    },
    claimAllNotes: async () => {
      events.push('claim');
    },
    waitForGuardianSettled: async () => {
      events.push('settle');
      await settle();
    },
    lockWallet: async () => {
      events.push('lock');
      throw stopped;
    }
  };
  const midenCli = {
    init: async () => {},
    createFaucet: async () => 'faucet',
    mint: async () => {},
    sync: async () => {}
  };
  const steps = { step: async (_name: string, run: () => Promise<void>) => run() };
  return { events, stopped, run: () => mockJourney({ walletA: wallet, midenCli, steps }) };
}

it('tracks before funding and holds destructive reset until the funded Guardian delta is canonical', async () => {
  let canonicalize!: () => void;
  const settling = new Promise<void>(resolve => {
    canonicalize = resolve;
  });
  const f = fixture(() => settling);
  const result = f.run().catch(error => error);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(f.events).toEqual(['track', 'create', 'claim', 'settle']);
  canonicalize();
  expect(await result).toBe(f.stopped);
  expect(f.events).toEqual(['track', 'create', 'claim', 'settle', 'lock']);
});

it('preserves the wallet when the Guardian cannot canonicalize the funded state', async () => {
  const failure = new Error('guardian has not canonicalized the last pushed delta');
  const f = fixture(async () => {
    throw failure;
  });
  await expect(f.run()).rejects.toBe(failure);
  expect(f.events).not.toContain('lock');
});
