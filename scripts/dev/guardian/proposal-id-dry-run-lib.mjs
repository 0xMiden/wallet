import { createHash } from 'node:crypto';

const POST_PUSH_VERIFICATION_NAMES = new Set([
  'BoundBlockMismatchError',
  'ProposalSaltMalformedError',
  'ChainBehindBoundBlockError'
]);

export function installWordFreeShim(sdkModule) {
  const Word = sdkModule?.Word;
  const prototype = typeof Word === 'function' ? Word.prototype : undefined;
  if (prototype && typeof prototype.free !== 'function' && Object.isExtensible(prototype)) {
    Object.defineProperty(prototype, 'free', { value: () => {}, configurable: true, writable: true });
  }
}

export async function solveFaucetPow(
  challengeHex,
  target,
  { deadlineMs = 30_000, hashesPerBatch = 20_000, hash } = {}
) {
  const targetValue = BigInt(target);
  const deadline = Date.now() + deadlineMs;
  const challenge = Buffer.from(challengeHex.replace(/^0x/, ''), 'hex');
  const buffer = Buffer.alloc(challenge.length + 8);
  challenge.copy(buffer);
  const readDigestPrefix = hash ?? (bytes => createHash('sha256').update(bytes).digest().readBigUInt64BE(0));
  const batchSize = Number.isFinite(hashesPerBatch)
    ? Math.min(20_000, Math.max(1, Math.floor(hashesPerBatch)))
    : 20_000;
  let nonce = 0n;

  const unsolved = () => new Error(`faucet proof of work unsolved within ${deadlineMs}ms; target=${targetValue}`);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw unsolved();

  for (;;) {
    if (Date.now() >= deadline) throw unsolved();
    for (let batch = 0; batch < batchSize; batch++) {
      buffer.writeBigUInt64BE(nonce, challenge.length);
      if (readDigestPrefix(buffer) < targetValue) return Number(nonce);
      nonce++;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

export function isPostPushProposalVerificationFailure(error) {
  const name = error?.name;
  const message = typeof error?.message === 'string' ? error.message : String(error);
  if (name === 'ProposalIdMismatchError' || name === 'TransactionSummaryLayoutError') return false;
  if (error?.status === 409 || /conflict_pending|pending delta/i.test(message)) return false;
  if (/failed to decode transaction request/i.test(message)) return false;
  return (
    message.startsWith('Invalid proposal:') ||
    POST_PUSH_VERIFICATION_NAMES.has(name) ||
    message.includes('malformed boundBlockNum')
  );
}

export async function proposeKnownNonce({ client, multisig, accountId, create }) {
  const storeAccount = await client.accounts.get(accountId);
  const account = storeAccount ?? multisig.account;
  const nonceValue = BigInt(account.nonce().asInt()) + 1n;
  if (nonceValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Guardian proposal nonce is too large to represent safely');
  }
  const nonce = Number(nonceValue);

  try {
    return await create(nonce);
  } catch (error) {
    if (!isPostPushProposalVerificationFailure(error)) throw error;
    try {
      // The proposal never came back, so there is no id: the nonce-only request, which Guardians 0.18 and 0.19 accept.
      await multisig.abandonCandidate(nonce, undefined);
    } catch (abandonError) {
      console.warn(
        `[Guardian] could not abandon candidate at nonce ${nonce} after SDK verification failed:`,
        abandonError
      );
    }
    throw error;
  }
}
