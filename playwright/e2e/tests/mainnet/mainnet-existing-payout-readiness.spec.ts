import { writeFileSync } from 'node:fs';
import { Address, NoteFile } from '@miden-sdk/miden-sdk';
import { expect, test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { readTransactionRows } from '../../helpers/history';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { readMainnetSwapPayback, prepareMainnetSwapClaimRecovery } from '../../helpers/mainnet-swap-claim';
import { exportPublicInputNote } from '../../helpers/swap';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });
test('read-only replacement claim boundary; never arm or consume', async ({ walletB }) => {
  test.setTimeout(240000);
  const state = loadMainnetSwapCheckpoint('test-results/original-authority/roundtrip.json');
  if (!state || state.authorizationRunId !== '43485129750' || !state.reverseRequestAuthority) throw new Error('Wrong retained replacement');
  const authority = state.reverseRequestAuthority;
  const report: Record<string, unknown> = { purpose: 'on-chain read-only public payout discovery and claim readiness; no authority or execution', inspected: false };
  let stage = 'restore';
  try {
    await restoreMainnetLoopGuardian(walletB,process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
    expect(await walletB.getAccountAddress()).toBe(state.account);
    await walletB.refreshBalancesLanded(90000);
    stage = 'balances';
    report.balances = {
      native: (await vaultBalanceByFaucetId(walletB.page,state.native.faucetId)).toString(),
      request: (await vaultBalanceByFaucetId(walletB.page,state.request.faucetId)).toString()
    };
    stage = 'public-payback';
    try {
      const proof = await readMainnetSwapPayback('https://rpc.mainnet.miden.io', {
        kind:'swap',accountId:Address.fromBech32(state.account).accountId().toString(),
        faucetId:state.request.hex,amount:state.returnAmount ?? '0',requestedFaucetId:state.offer.hex,
        requestedAmount:authority.minimumReceive,noteId:authority.noteId,orderId:authority.orderId
      });
      report.payback = proof ? { ...proof,amount:proof.amount.toString() } : null;
      if (!proof || proof.claimedAtBlock !== undefined) throw new Error('Existing payout is not unclaimed');
      const current={native:await vaultBalanceByFaucetId(walletB.page,state.native.faucetId),request:await vaultBalanceByFaucetId(walletB.page,state.request.faucetId),offer:await vaultBalanceByFaucetId(walletB.page,state.offer.faucetId)};
      const prepared=prepareMainnetSwapClaimRecovery(state,proof,current);
      report.aggregateNativeCosts=prepared.paidFees;
      report.claimNativeBefore=prepared.recoveryClaimNativeBefore;
      report.claimReadinessStage='export-note';
      try {
        const file=await exportPublicInputNote(walletB,proof.noteId);
        const decoded=NoteFile.deserialize(Buffer.from(file,'hex'));
        expect(decoded.noteId()?.toString()).toBe(proof.noteId);
        expect(decoded.inclusionProof()).toBeDefined();
        report.claimExportReady=true;
      } catch(error) {
        const message=error instanceof Error?error.message:'';
        report.exportErrorText=message.replace(/[A-Za-z0-9+/_=-]{24,}/g,'[redacted]').replace(/\b\d{9,}\b/g,'[redacted]').slice(0,200);
        report.exportErrorKind=/not found|not exist|missing note/i.test(message)?'note-not-found':/proof|commitment|not committed/i.test(message)?'inclusion-proof':/unsupported|format/i.test(message)?'unsupported-format':/lock|deadlock/i.test(message)?'client-lock':/network|fetch|rpc|transport/i.test(message)?'rpc':'unclassified';
      }
      report.claimReadinessStage='pending-accept';
      await walletB.page.goto(`chrome-extension://${walletB.extensionId}/fullpage.html#/`);
      await expect(walletB.page.locator(`[data-pending-note-id="${proof.noteId}"]`).getByRole('button',{name:/^Accept$/})).toBeVisible({timeout:15000});
      report.claimUIReady=true;
      report.claimReadinessStage='complete';
      expect(await vaultBalanceByFaucetId(walletB.page,state.native.faucetId)).toBe(current.native);
    } catch(error) {
      const safe = ['Missing exact original public PSWAP','Invalid original recorded protocol identity','Multiple paybacks for the original full-fill order','Payback differs from the exact original full-fill protocol note'];
      report.publicProofError = error instanceof Error && safe.includes(error.message) ? error.message : error instanceof Error ? error.name : 'unknown';
    }
    stage = 'history';
    const rows = await readTransactionRows(walletB.page);
    report.unresolvedRows=rows.some(row=>row.status===0||row.status===1||row.status===4);
    expect(report.unresolvedRows).toBe(false);
    const parents = rows.filter(row => row.type==='swap' && String(row.extraInputs?.orderId)===authority.orderId);
    report.creationRows = parents.map(row=>({id:row.id,type:row.type,status:row.status,amount:row.amount,faucetId:row.faucetId,feeAmount:row.feeAmount,feeFaucetId:row.feeFaucetId,completedAt:row.completedAt,minimumReceive:String(row.extraInputs?.requestedAmount),requestedFaucetId:row.extraInputs?.requestedFaucetId,autoConsume:row.extraInputs?.autoConsume}));
    report.consumeRows = rows.filter(row=>row.type==='consume'&&parents.some(parent=>row.extraInputs?.swapOrderTxId===parent.id)).map(row=>({id:row.id,status:row.status,amount:row.amount,faucetId:row.faucetId,feeAmount:row.feeAmount,feeFaucetId:row.feeFaucetId}));
    const policyKeys = ['e2e_mainnet_send_authorization','e2e_mainnet_consume_authorization'];
    const stored = await walletB.page.evaluate(async keys=>chrome.storage.local.get(keys),[...policyKeys,'e2e_mainnet_consume_authorization_required']);
    report.noLivePolicy = policyKeys.every(key=>stored[key]===undefined);
    const marker=stored.e2e_mainnet_consume_authorization_required;
    report.consumeBlocked = marker&&typeof marker==='object'&&Object.keys(marker).length===1&&marker.status==='blocked';
    expect(report.noLivePolicy).toBe(true); expect(report.consumeBlocked).toBe(true);
    report.inspected = true;
  } catch(error) { report.errorStage=stage;report.errorKind=error instanceof Error&&error.name==='TimeoutError'?'timeout':'rejected'; }
  finally { writeFileSync('test-results/read-only-existing-payout-ready.json',JSON.stringify(report,null,2)); }
  expect(report.inspected).toBe(true);
  expect(report.claimUIReady).toBe(true);
  expect(report.claimExportReady).toBe(true);
});
