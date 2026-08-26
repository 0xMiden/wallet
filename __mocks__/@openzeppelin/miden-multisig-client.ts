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
  signerCommitments: string[] = ['0xhot', '0xcold'];
  constructor(..._args: unknown[]) {}
  static fromAccount = jest.fn(() => new AccountInspector());
}

export class GuardianHttpClient {
  constructor(..._args: unknown[]) {}
  setSigner = jest.fn();
  getState = jest.fn();
  getPubkey = jest.fn();
}

export class GuardianHttpError extends Error {}

export class FalconSigner {
  constructor(..._args: unknown[]) {}
}

export class EcdsaSigner {
  // The guardian auto-detection probe reads `commitment` and authenticates the
  // lookup with `signLookupMessage`; both are cheap stubs here.
  readonly commitment = 'ecdsa-commitment';
  readonly publicKey = 'ecdsa-public-key';
  constructor(..._args: unknown[]) {}
  signLookupMessage = jest.fn(async () => 'ecdsa-lookup-signature');
  signCommitment = jest.fn(async () => 'ecdsa-signature');
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
// 0.17 shape: { summary, anchor } — the summary binds the anchored reference
// block (protocol 0.16), and the anchor ships alongside for anchored execution.
export const executeForSummary = jest.fn(async () => ({
  summary: {
    serialize: () => new Uint8Array([0xab]),
    toCommitment: () => ({ toHex: () => '0xsummary-commitment' })
  },
  anchor: { free: jest.fn(), commitment: () => ({ toHex: () => '0xanchor-commitment' }) }
}));

export const chainAnchorToBase64 = jest.fn(() => 'chain-anchor-b64');
export const chainAnchorFromBase64 = jest.fn(() => ({
  free: jest.fn(),
  commitment: () => ({ toHex: () => '0xanchor-commitment' })
}));

// Update-guardian builder used by the direct-switch fallback.
export const buildUpdateGuardianTransactionRequest = jest.fn(async () => ({
  request: { kind: 'update-guardian-request', serialize: () => new Uint8Array([0xcd]) },
  salt: { toHex: () => 'salt-hex' }
}));

// Real heuristic (copied from the package's connectivity.ts) — the direct-switch
// fallback's unreachable-vs-semantic-error routing depends on it behaving
// faithfully, so this is NOT a jest.fn stub.
export const isLikelyNetworkError = (err: unknown): boolean => {
  const message = (err as { message?: string } | null | undefined)?.message ?? String(err ?? '');
  const lower = message.toLowerCase();
  if (lower.includes('failed to fetch')) return true;
  if (lower.includes('networkerror')) return true;
  if (lower.includes('network error')) return true;
  if (lower.includes('load failed')) return true;
  if (lower.includes('abort')) return true;
  if (lower.includes('timeout') || lower.includes('timed out')) return true;
  if (lower.includes('connection')) return true;
  if (lower.includes('econnrefused') || lower.includes('enotfound')) return true;
  if (lower.includes('dns')) return true;
  return false;
};

export class StorageLayoutBuilder {
  constructor(..._args: unknown[]) {}
}
