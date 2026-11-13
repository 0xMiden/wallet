import { writeFileSync } from 'node:fs';
import { Address } from '@miden-sdk/miden-sdk';
import { expect, test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { readTransactionRows } from '../../helpers/history';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { readMainnetSwapPayback } from '../../helpers/mainnet-swap-claim';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });
test('read-only replacement claim boundary; never arm or consume', async ({ walletB }) => {
  test.setTimeout(240000);
  const state = loadMainnetSwapCheckpoint('test-results/original-authority/roundtrip.json');
  if (!state || state.authorizationRunId !== '43485129750' || !state.reverseRequestAuthority) throw new Error('Wrong retained replacement');
  const authority = state.reverseRequestAuthority;
  const report: Record<string, unknown> = { purpose: 'read-only replacement claim diagnostics; no new authority or execution', inspected: false };
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
    } catch(error) {
      const safe = ['Missing exact original public PSWAP','Invalid original recorded protocol identity','Multiple paybacks for the original full-fill order','Payback differs from the exact original full-fill protocol note'];
      report.publicProofError = error instanceof Error && safe.includes(error.message) ? error.message : error instanceof Error ? error.name : 'unknown';
    }
    stage = 'history';
    const rows = await readTransactionRows(walletB.page);
    const parents = rows.filter(row => row.type==='swap' && String(row.extraInputs?.orderId)===authority.orderId);
    report.creationRows = parents.map(row=>({id:row.id,type:row.type,status:row.status,amount:row.amount,faucetId:row.faucetId,feeAmount:row.feeAmount,feeFaucetId:row.feeFaucetId,completedAt:row.completedAt}));
    report.consumeRows = rows.filter(row=>row.type==='consume'&&parents.some(parent=>row.extraInputs?.swapOrderTxId===parent.id)).map(row=>({id:row.id,status:row.status,amount:row.amount,faucetId:row.faucetId,feeAmount:row.feeAmount,feeFaucetId:row.feeFaucetId}));
    const policyKeys = ['e2e_mainnet_send_authorization','e2e_mainnet_consume_authorization'];
    const stored = await walletB.page.evaluate(async keys=>chrome.storage.local.get(keys),[...policyKeys,'e2e_mainnet_consume_authorization_required']);
    report.noLivePolicy = policyKeys.every(key=>stored[key]===undefined);
    const marker=stored.e2e_mainnet_consume_authorization_required;
    report.consumeBlocked = marker&&typeof marker==='object'&&Object.keys(marker).length===1&&marker.status==='blocked';
    expect(report.noLivePolicy).toBe(true); expect(report.consumeBlocked).toBe(true);
    report.inspected = true;
  } catch(error) { report.errorStage=stage;report.errorKind=error instanceof Error&&error.name==='TimeoutError'?'timeout':'rejected'; }
  finally { writeFileSync('test-results/read-only-claim-boundary.json',JSON.stringify(report,null,2)); }
  expect(report.inspected).toBe(true);
});
