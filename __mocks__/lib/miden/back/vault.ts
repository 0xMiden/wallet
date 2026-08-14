const state = {
  exists: false,
  accounts: [] as any[],
  settings: {} as any,
  currentAccount: null as any,
  ownMnemonic: false
};

export class Vault {
  static async isExist() {
    return state.exists;
  }

  static async spawn(_password: string, _mnemonic?: string, ownMnemonic?: boolean) {
    state.exists = true;
    const account = {
      publicKey: 'miden-account-1',
      name: 'Miden Account 1',
      isPublic: true,
      type: 0,
      hdIndex: 0
    };
    state.accounts = [account];
    state.currentAccount = account;
    state.ownMnemonic = Boolean(ownMnemonic);
    return new Vault();
  }

  static async spawnFromMidenClient(password: string, mnemonic: string) {
    await Vault.spawn(password, mnemonic, true);
    return new Vault();
  }

  static async setup(_password: string) {
    return new Vault();
  }

  static async getCurrentAccountPublicKey() {
    return state.currentAccount?.publicKey ?? null;
  }

  async fetchAccounts() {
    return state.accounts;
  }

  // Best-effort on-unlock migration of legacy single-key Guardian accounts to
  // the 3-key model — a no-op in the mock (no real accounts/keys to migrate).
  async migrateLegacyGuardianAccounts() {}

  // Best-effort on-unlock backfill of wallet-derived EVM addresses onto
  // pre-existing HD accounts — a no-op in the mock (no seed to derive from).
  async backfillEvmAddresses() {}

  // Best-effort post-unlock backfill of guardianEndpoint onto legacy Guardian
  // accounts (#408 stage 2) — a no-op in the mock (no accounts to resolve).
  async backfillGuardianEndpoints() {}

  async fetchSettings() {
    return state.settings;
  }

  async getCurrentAccount() {
    return state.currentAccount;
  }

  async isOwnMnemonic() {
    return state.ownMnemonic;
  }

  async createHDAccount(_walletType: number, name?: string) {
    const index = state.accounts.length;
    const account = {
      publicKey: `miden-account-${index + 1}`,
      name: name ?? `Miden Account ${index + 1}`,
      isPublic: true,
      type: 0,
      hdIndex: index
    };
    state.accounts = [...state.accounts, account];
    return state.accounts;
  }

  async editAccountName(publicKey: string, name: string) {
    state.accounts = state.accounts.map(acc => (acc.publicKey === publicKey ? { ...acc, name } : acc));
    return { accounts: state.accounts };
  }

  async setCurrentAccount(publicKey: string) {
    const found = state.accounts.find(acc => acc.publicKey === publicKey) ?? null;
    state.currentAccount = found;
    return found;
  }

  async updateSettings(settings: any) {
    state.settings = { ...state.settings, ...settings };
    return state.settings;
  }

  async signTransaction(_publicKey: string, signingInputs: string) {
    // Return hex so front-end conversion can create bytes
    return 'abcd';
  }

  async getAuthSecretKey(key: string) {
    return `secret:${key}`;
  }
}
