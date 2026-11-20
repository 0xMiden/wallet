import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, getAddress, http, isHash } from 'viem';
import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { mainnetChain, mainnetRpc } from '../../helpers/mainnet-bridge-sources';
import { expect } from '@playwright/test';
import { readTransactionRows, TxStatus } from '../../helpers/history';
import { canonicalMainnetLoopFaucet } from '../../helpers/mainnet-loop-config';
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
  stage = 'restored-fee-history';
  await expect.poll(async () => {
    const rows = (await readTransactionRows(walletB.page)).filter(row => row.transactionId?.toLowerCase() === creator.transactionId);
    if (!rows.length) return 'missing';
    if (rows.length !== 1) return 'ambiguous';
    const [row] = rows;
    return row?.status === TxStatus.Completed && row.feeAmount === fee.toString() && row.feeFaucetId &&
      canonicalMainnetLoopFaucet(row.feeFaucetId) === state.native.hex ? 'verified' : 'incomplete';
  }, { timeout: 60_000 }).toBe('verified');
  assert.equal(digest(), hash);
  writeFileSync('test-results/green04-near-custody.json', JSON.stringify({
    sourceRunId: state.sourceRunId, checkpointHash: hash, publicSourceAndPayoutVerified: true,
    privateCustodyVerified: true, nativeFeeBaseUnits: fee.toString(), heldBaseUnits: received.toString(),
    pendingNonce: pending, noNewAuthority: true, checkpointUnchanged: true, roundTripComplete: false
  }));
});
