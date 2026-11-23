import { parsePrivateKeyPair } from '../../../src/lib/miden/guardian/private-key-pair';
import { withRpcTimeout } from '../../../src/lib/miden-chain/rpc-timeout';

interface RecordedFeeScope {
  account: string;
  note: string;
  faucet: string;
  budget: bigint;
  vaultDebit: bigint;
}

interface RecordedFeeEvidence {
  account: string;
  notes: readonly string[];
  fees: readonly { faucet: string; amount: bigint }[];
}

export function verifyRecordedNearFee(scope: RecordedFeeScope, evidence: RecordedFeeEvidence): bigint {
  const [fee] = evidence.fees;
  if (
    evidence.account !== scope.account ||
    evidence.notes.filter(note => note === scope.note).length !== 1 ||
    evidence.fees.length !== 1 ||
    !fee ||
    fee.faucet !== scope.faucet ||
    fee.amount <= 0n ||
    fee.amount > scope.budget ||
    fee.amount !== scope.vaultDebit
  )
    throw new Error('Missing actual original native NEAR mint fee');
  return fee.amount;
}

export async function readRecordedNearFee(scope: RecordedFeeScope, keyPair: string): Promise<bigint> {
  const pair = parsePrivateKeyPair(keyPair);
  if (!pair) throw new Error('Original NEAR Guardian key unavailable');
  const { GuardianHttpClient } = await import('@openzeppelin/guardian-client');
  const { EcdsaSigner } = await import('@openzeppelin/miden-multisig-client');
  const { AuthSecretKey, TransactionSummary } = await import('@miden-sdk/miden-sdk');
  const bytes = Buffer.from(`01${pair.hotPrivateKey}`, 'hex');
  const key = (() => {
    try {
      return AuthSecretKey.deserialize(bytes);
    } finally {
      bytes.fill(0);
    }
  })();
  const guardian = new GuardianHttpClient('https://guardian.cedar.internal.lambdaclass.com');
  guardian.setSigner(new EcdsaSigner(key));
  const page = await withRpcTimeout(() => guardian.getDeltaHistory(scope.account, { limit: 20 }), 'NEAR fee history', {
    retries: 0
  });
  const hits = page.entries.filter(entry => entry.outputNotes.some(output => output.noteId === scope.note));
  const [hit] = hits;
  if (
    page.entries.length > 20 ||
    hits.length !== 1 ||
    !hit ||
    hit.status !== 'canonical' ||
    !Number.isSafeInteger(hit.nonce) ||
    hit.nonce <= 0
  )
    throw new Error('Missing unique original NEAR Guardian history entry');
  const delta = await withRpcTimeout(() => guardian.getDelta(scope.account, hit.nonce), 'NEAR fee delta', {
    retries: 0
  });
  const encoded = delta.deltaPayload?.txSummary?.data;
  if (
    delta.accountId !== scope.account ||
    delta.nonce !== hit.nonce ||
    delta.status.status !== 'canonical' ||
    typeof encoded !== 'string' ||
    !encoded.length ||
    encoded.length > 4_000_000
  )
    throw new Error('Invalid original NEAR Guardian delta');
  const summary = TransactionSummary.deserialize(Buffer.from(encoded, 'base64'));
  const outputs = summary.outputNotes().notes();
  const fees = outputs
    .filter(output => output.metadata().tag().asU32() === 0xfee)
    .map(output => {
      const assets = output.assets();
      const fungible = assets?.fungibleAssets();
      const asset = fungible?.[0];
      if (assets?.assets().length !== 1 || fungible?.length !== 1 || !asset)
        throw new Error('Invalid original NEAR fee output');
      return { faucet: asset.faucetId().toString(), amount: asset.amount() };
    });
  return verifyRecordedNearFee(scope, {
    account: summary.accountDelta().id().toString(),
    notes: outputs.map(output => output.id().toString()),
    fees
  });
}
