/**
 * Automatic mock for @openzeppelin/miden-multisig-client.
 *
 * The real package is ESM (type: "module") and pulls in WASM-bound classes
 * that jsdom can't exec. Tests don't exercise the multisig flow — they just
 * need the module to load when guardian/front code is transitively imported.
 */

export class MultisigClient {
  constructor(..._args: unknown[]) {}
  load = jest.fn();
}

export class Multisig {
  accountId = '';
  account = null;
  createP2idProposal = jest.fn();
  createConsumeNotesProposal = jest.fn();
  createProposal = jest.fn();
  createTransactionProposalRequest = jest.fn();
  signProposal = jest.fn();
  executeProposal = jest.fn();
  syncState = jest.fn();
  nonce = jest.fn(() => ({ asInt: () => 0n }));
}

export class AccountInspector {
  constructor(..._args: unknown[]) {}
}

export class GuardianHttpClient {
  constructor(..._args: unknown[]) {}
  setSigner = jest.fn();
  getState = jest.fn();
  getPubkey = jest.fn();
}

export class GuardianHttpError extends Error {}

export class EcdsaSigner {
  constructor(..._args: unknown[]) {}
}

export class ParaSigner {
  constructor(..._args: unknown[]) {}
}

export class MidenWalletSigner {
  constructor(..._args: unknown[]) {}
}

export const createMultisigAccount = jest.fn();
export const validateMultisigConfig = jest.fn();
export const buildMultisigStorageSlots = jest.fn();
export const buildGuardianStorageSlots = jest.fn();
export const storageLayoutBuilder = jest.fn();

// Update-signers + summary builders used by createReplaceHotKeyProposal. The
// real implementations touch WASM; tests mock-or-spy as needed.
export const buildUpdateSignersTransactionRequest = jest.fn(async () => ({
  request: { kind: 'update-signers-request' },
  salt: { toHex: () => 'salt-hex' }
}));
export const executeForSummary = jest.fn(async () => ({
  serialize: () => new Uint8Array([0xab])
}));

export class StorageLayoutBuilder {
  constructor(..._args: unknown[]) {}
}
