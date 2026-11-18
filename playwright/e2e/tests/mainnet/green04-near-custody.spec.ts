import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, getAddress, http, isHash } from 'viem';
import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { mainnetChain, mainnetRpc } from '../../helpers/mainnet-bridge-sources';
import { readTransactionRowsWithBytes, TxStatus, type TransactionRowSnapshot } from '../../helpers/history';
import { canonicalMainnetLoopFaucet } from '../../helpers/mainnet-loop-config';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { readMainnetMidenOwnNoteCreator } from '../../helpers/mainnet-miden-indexer';
import { verifyMainnetMidenNoteInclusion } from '../../helpers/mainnet-miden-read';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { inspectMainnetNearForwardReceipt } from '../../helpers/mainnet-near-evm';
import { createMainnetOneClickOriginFetcher } from '../../helpers/mainnet-one-click-origin';
import { fetchOneClickStatus } from '../../../../src/lib/one-click/client';
import { hashOneClickQuote } from '../../../../src/lib/one-click/signature';

const checkpoint = 'test-results/near/roundtrip.json';
const digest = () => createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
test.use({ injectFeeFaucet: false });
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
  const creator = await readMainnetMidenOwnNoteCreator(note, state.accountHex);
  await verifyMainnetMidenNoteInclusion('https://rpc.mainnet.miden.io', note, creator.blockNumber, state.accountHex);
  const quote = state.forwardQuote;
  const status = await fetchOneClickStatus(
    { serviceUrl: state.serviceUrl, appFees: state.appFees, feePolicy: state.feePolicy,
      midenAssets: [{ assetId: state.nativeAssetId, faucetId: state.native.hex, decimals: 6 }] },
    quote.depositAddress, undefined, undefined,
    createMainnetOneClickOriginFetcher(state.serviceUrl, walletB.extensionId)
  );
  assert.equal(status.status, 'SUCCESS');
  assert.equal(hashOneClickQuote(status.quoteResponse), quote.quoteHash);
  assert.equal(status.swapDetails.originChainTxHashes.length, 1);
  assert.equal(status.swapDetails.originChainTxHashes[0]?.hash.toLowerCase(), creator.transactionId);
  assert.equal(status.swapDetails.destinationChainTxHashes.length, 1);
  const payout = status.swapDetails.destinationChainTxHashes[0]?.hash.toLowerCase();
  assert.ok(isHash(payout));
  const client = createPublicClient({ chain: mainnetChain(state.evm.chainId), transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 }) });
  const receipt = await client.getTransactionReceipt({ hash: payout });
  const received = inspectMainnetNearForwardReceipt(state, payout, receipt);
  const account = getAddress(state.evm.account);
  const [token, gas, latest, pending] = await Promise.all([
    client.readContract({ address: getAddress(state.evm.token), abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.getBalance({ address: account }),
    client.getTransactionCount({ address: account, blockTag: 'latest' }),
    client.getTransactionCount({ address: account, blockTag: 'pending' })
  ]);
  assert.equal(token, BigInt(state.evm.tokenBalance) + received);
  assert.equal(gas, BigInt(state.evm.nativeBalance));
  assert.equal(latest, pending);
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), state.account);
  const native = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
  const rows: TransactionRowSnapshot[] = (await readTransactionRowsWithBytes(walletB.page, 'send')).filter(
    row => row.outputNoteIds?.includes(note) && row.status === TxStatus.Completed
  );
  const row = rows[0];
  assert.ok(rows.length === 1 && row?.feeAmount && /^[1-9]\d*$/.test(row.feeAmount) && row.feeFaucetId);
  assert.equal(canonicalMainnetLoopFaucet(row.feeFaucetId), state.native.hex);
  if (row.transactionId) assert.equal(row.transactionId.toLowerCase(), creator.transactionId);
  assert.equal(native, BigInt(state.native.balance) - BigInt(state.principal) - BigInt(row.feeAmount));
  assert.equal(digest(), hash);
  writeFileSync('test-results/green04-near-custody.json', JSON.stringify({
    sourceRunId: state.sourceRunId, checkpointHash: hash, publicSourceAndPayoutVerified: true,
    privateCustodyVerified: true, nativeFeeBaseUnits: row.feeAmount, heldBaseUnits: received.toString(),
    pendingNonce: pending, noNewAuthority: true, checkpointUnchanged: true, roundTripComplete: false
  }));
});
