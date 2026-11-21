import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, getAddress, http, isHash } from 'viem';
import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { mainnetChain, mainnetRpc } from '../../helpers/mainnet-bridge-sources';
import { parsePrivateKeyPair } from '../../../../src/lib/miden/guardian/private-key-pair';
import { isRecord } from '../../../../src/lib/update/guards';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { readMainnetMidenOwnNoteCreator } from '../../helpers/mainnet-miden-indexer';
import { verifyMainnetMidenNoteInclusion } from '../../helpers/mainnet-miden-read';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { inspectMainnetNearForwardReceipt, matchesMainnetNearMidenSource } from '../../helpers/mainnet-near-evm';
import { createMainnetOneClickOriginFetcher } from '../../helpers/mainnet-one-click-origin';
import { fetchOneClickStatus, OneClickHttpError } from '../../../../src/lib/one-click/client';
import { hashOneClickQuote } from '../../../../src/lib/one-click/signature';

const checkpoint = 'test-results/near/roundtrip.json';
const digest = () => createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
let stage = 'checkpoint';
let statusFailure: string | undefined;
test.use({ injectFeeFaucet: false });
test.afterEach(async ({}, info) => {
  if (info.status !== 'passed') writeFileSync('test-results/green04-near-stage.json', JSON.stringify({ stage, statusFailure }));
});
test('bind the original NEAR deposit to the public payout and actual private custody', async ({ walletB }) => {
  test.setTimeout(300_000);
  const hash = digest();
  assert.equal(hash, '49280822379e8ce1e83a36e11e128e28ebee70001a2eadc56ce654ed410c7147');
  const state = loadMainnetNearCheckpoint(checkpoint);
  assert.ok(state?.sendAuthority && state.forwardQuote);
  assert.equal(state.sourceRunId, '44318071333');
  assert.equal(state.authorizationRunId, state.sourceRunId);
  assert.equal(state.phase, 'forward-authorized');
  assert.equal(state.reverseQuote, undefined);
  assert.equal(state.transactions, undefined);
  const note = state.sendAuthority.noteId;
  stage = 'public-note-creator';
  const creator = await readMainnetMidenOwnNoteCreator(note, state.accountHex);
  stage = 'public-note-inclusion';
  await verifyMainnetMidenNoteInclusion('https://rpc.mainnet.miden.io', note, creator.blockNumber, state.accountHex);
  const quote = state.forwardQuote;
  stage = 'signed-provider-status';
  const status = await fetchOneClickStatus(
    { serviceUrl: state.serviceUrl, appFees: state.appFees, feePolicy: state.feePolicy,
      midenAssets: [{ assetId: state.nativeAssetId, faucetId: state.native.hex, decimals: 6 }] },
    quote.depositAddress, undefined, undefined,
    createMainnetOneClickOriginFetcher(state.serviceUrl, walletB.extensionId)
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    statusFailure = error instanceof OneClickHttpError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
      ? `http-${error.status}`
      : message === '1Click status quote signature is invalid' ? 'signature'
      : message.startsWith('Invalid 1Click status') || message.startsWith('Invalid 1Click quote') ? 'schema'
      : message.includes('configured app fee') ? 'fee-binding'
      : message === 'Invalid 1Click test service URL' ? 'test-config'
      : message === '1Click request timed out' ? 'timeout' : 'other';
    throw new Error('Read-only provider status could not be verified');
  });
  stage = 'provider-settlement-state';
  assert.equal(status.status, 'SUCCESS');
  stage = 'provider-quote-digest';
  assert.equal(hashOneClickQuote(status.quoteResponse), quote.quoteHash);
  stage = 'provider-source-correlation';
  assert.ok(matchesMainnetNearMidenSource(status.swapDetails.originChainTxHashes, creator.transactionId, note));
  assert.equal(status.swapDetails.originChainTxHashes[0]?.hash.toLowerCase(), note);
  assert.equal(status.swapDetails.destinationChainTxHashes.length, 1);
  const payout = status.swapDetails.destinationChainTxHashes[0]?.hash.toLowerCase();
  assert.ok(payout && isHash(payout));
  stage = 'evm-payout-receipt';
  const client = createPublicClient({ chain: mainnetChain(state.evm.chainId), transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 }) });
  const receipt = await client.getTransactionReceipt({ hash: payout });
  const received = inspectMainnetNearForwardReceipt(state, payout, receipt);
  const account = getAddress(state.evm.account);
  stage = 'evm-holdings';
  const [token, gas, latest, pending] = await Promise.all([
    client.readContract({ address: getAddress(state.evm.token), abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.getBalance({ address: account }),
    client.getTransactionCount({ address: account, blockTag: 'latest' }),
    client.getTransactionCount({ address: account, blockTag: 'pending' })
  ]);
  assert.equal(token, BigInt(state.evm.tokenBalance) + received);
  assert.equal(gas, BigInt(state.evm.nativeBalance));
  assert.equal(latest, pending);
  stage = 'private-restore';
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), state.account);
  const native = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
  stage = 'public-account-interval';
  const prior = JSON.parse(readFileSync('test-results/epoch/roundtrip.json', 'utf8'));
  assert.equal(prior.sourceRunId, state.sourceRunId);
  assert.equal(prior.phase, 'complete');
  assert.equal(prior.after.native, state.native.balance);
  assert.ok(isHash(prior.returnMidenTxId));
  const txs = await fetch('https://scan-backend-cedar-miden.eu-central-8.gateway.fm/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ query: 'query($a:String!){transactions(first:2,input:{account_bech:$a,order_by:desc,sort_by:timestamp}){edges{node{transaction_id account_bech block_number}}}}', variables: {a: creator.senderAddress} })
  });
  assert.ok(txs.ok);
  const history = await txs.json();
  assert.ok(isRecord(history) && !history.errors && isRecord(history.data) && isRecord(history.data.transactions));
  const edges = history.data.transactions.edges;
  assert.ok(Array.isArray(edges) && edges.length === 2);
  assert.ok(edges.every(edge => edge?.node?.account_bech === creator.senderAddress));
  assert.equal(edges[0].node.transaction_id, creator.transactionId);
  assert.equal(edges[0].node.block_number, String(creator.blockNumber));
  assert.equal(edges[1].node.transaction_id, prior.returnMidenTxId);
  assert.ok(Number(edges[1].node.block_number) < creator.blockNumber);
  stage = 'private-vault-delta';
  const fee = BigInt(state.native.balance) - BigInt(state.principal) - native;
  assert.ok(fee >= BigInt(state.baseFee) && fee <= BigInt(state.feeBudget));
  stage = 'guardian-sdk-import';
  const { GuardianHttpClient } = await import('@openzeppelin/guardian-client');
  const { EcdsaSigner } = await import('@openzeppelin/miden-multisig-client');
  const { AuthSecretKey, TransactionSummary } = await import('@miden-sdk/miden-sdk');
  stage = 'guardian-history-read';
  const pair = parsePrivateKeyPair(process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.ok(pair);
  const keyBytes = Buffer.from(`01${pair.hotPrivateKey}`, 'hex');
  const signer = new EcdsaSigner(AuthSecretKey.deserialize(keyBytes));
  keyBytes.fill(0);
  const guardian = new GuardianHttpClient('https://guardian.cedar.internal.lambdaclass.com');
  guardian.setSigner(signer);
  const page = await guardian.getDeltaHistory(state.accountHex, { limit: 20 });
  stage = 'guardian-history-note';
  assert.ok(page.entries.length <= 20);
  const hits = page.entries.filter(entry => entry.outputNotes.some(output => output.noteId.toLowerCase() === note));
  assert.equal(hits.length, 1);
  const [hit] = hits;
  assert.ok(hit && Number.isSafeInteger(hit.nonce) && hit.nonce > 0 && hit.status === 'canonical');
  stage = 'guardian-delta-read';
  const delta = await guardian.getDelta(state.accountHex, hit.nonce);
  assert.equal(delta.accountId.toLowerCase(), state.accountHex);
  assert.equal(delta.nonce, hit.nonce);
  stage = 'guardian-summary-fee';
  const encoded = delta.deltaPayload.txSummary.data;
  assert.ok(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 4_000_000);
  const summary = TransactionSummary.deserialize(Buffer.from(encoded, 'base64'));
  assert.equal(summary.accountDelta().id().toString(), state.accountHex);
  const outputs = summary.outputNotes().notes();
  assert.equal(outputs.filter(output => output.id().toString() === note).length, 1);
  const tagged = outputs.filter(output => output.metadata().tag().asU32() === 0xfee);
  assert.equal(tagged.length, 1);
  const assets = tagged[0]?.assets()?.fungibleAssets();
  assert.ok(assets?.length === 1 && assets[0]?.faucetId().toString() === state.native.hex);
  assert.equal(assets[0].amount(), fee);
  stage = 'provider-fee-split';
  const claim = (leg: string) => JSON.parse(readFileSync(`test-results/swap/mainnet-swap-${leg}-claim.json`, 'utf8'));
  const f = claim('forward');
  const r = claim('reverse');
  assert.equal(f.sourceRunId, state.sourceRunId);
  assert.equal(r.sourceRunId, state.sourceRunId);
  const scopes = [
    [f.originalNoteId, 'output'], [f.paybackNoteId, 'input'],
    [r.originalNoteId, 'output'], [r.paybackNoteId, 'input'],
    [prior.forwardNoteId, 'output'], [prior.returnNoteId, 'input']
  ];
  const nonces = new Set([hit.nonce]);
  const recorded: bigint[] = [];
  for (const [id, direction] of scopes) {
    assert.ok(isHash(id));
    const matches = page.entries.filter(entry => (direction === 'input' ? entry.inputNotes : entry.outputNotes).some(n => n.noteId === id));
    assert.equal(matches.length, 1);
    const entry = matches[0];
    assert.ok(entry && entry.status === 'canonical' && Number.isSafeInteger(entry.nonce) && entry.nonce > 0 && !nonces.has(entry.nonce));
    nonces.add(entry.nonce);
    const row = await guardian.getDelta(state.accountHex, entry.nonce);
    assert.equal(row.accountId.toLowerCase(), state.accountHex);
    assert.equal(row.nonce, entry.nonce);
    assert.equal(row.status.status, 'canonical');
    const data = row.deltaPayload.txSummary.data;
    assert.ok(data.length > 0 && data.length <= 4_000_000);
    const tx = TransactionSummary.deserialize(Buffer.from(data, 'base64'));
    assert.equal(tx.accountDelta().id().toString(), state.accountHex);
    const txOutputs = tx.outputNotes().notes();
    const noteIds = direction === 'input'
      ? tx.inputNotes().notes().map(input => input.note().id().toString())
      : txOutputs.map(output => output.id().toString());
    assert.equal(noteIds.filter(noteId => noteId === id).length, 1);
    const feeNotes = txOutputs.filter(output => output.metadata().tag().asU32() === 0xfee);
    assert.equal(feeNotes.length, 1);
    const paid = feeNotes[0]?.assets()?.fungibleAssets();
    assert.ok(paid?.length === 1 && paid[0]?.faucetId().toString() === state.native.hex && paid[0].amount() > 0n);
    recorded.push(paid[0].amount());
  }
  const swapFee = recorded.slice(0, 4).reduce((sum, x) => sum + x, 0n);
  const epochFee = recorded.slice(4).reduce((sum, x) => sum + x, 0n);
  assert.equal(swapFee, 532n);
  assert.equal(epochFee, BigInt(prior.paidMidenFees));
  assert.equal(swapFee + epochFee + fee, 931n);
  assert.equal(digest(), hash);
  writeFileSync('test-results/green04-near-custody.json', JSON.stringify({
    sourceRunId: state.sourceRunId, checkpointHash: hash, publicSourceAndPayoutVerified: true,
    privateCustodyVerified: true, nativeFeeBaseUnits: fee.toString(), heldBaseUnits: received.toString(),
    swapFeeBaseUnits: swapFee.toString(), epochFeeBaseUnits: epochFee.toString(),
    pendingNonce: pending, noNewAuthority: true, checkpointUnchanged: true, roundTripComplete: false
  }));
});
