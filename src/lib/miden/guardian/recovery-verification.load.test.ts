const mockI18nLoaded = jest.fn();

// Loading i18n runs platform setup, so a module the SDK client imports must not load it before it is needed.
jest.mock('lib/i18n', () => {
  mockI18nLoaded();
  return { getMessage: (key: string) => key };
});
jest.mock('@openzeppelin/miden-multisig-client', () => ({ AccountInspector: {} }));
jest.mock('../transaction/reconcile-reads', () => ({ RPC_READ_TIMEOUT_MS: 15000, createNodeReads: jest.fn() }));

it('loads i18n only when a recovery is refused', async () => {
  const { selectAdoptable } = await import('./recovery-verification');
  expect(mockI18nLoaded).not.toHaveBeenCalled();

  const state = { bytes: new Uint8Array(), accountIdHex: '0xa', nonce: 1n, isNew: false, commitment: 'ab' };
  await expect(selectAdoptable([{ state, verdict: 'unverified' }])).rejects.toThrow('guardianRecoveryUnverified');
  expect(mockI18nLoaded).toHaveBeenCalledTimes(1);
});
