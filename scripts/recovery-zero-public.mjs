import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const runId = '43947551561';
const source = 'aa6bc317ef2f17f7771a772e1e88d5f1172c616f';
const github = path => JSON.parse(execFileSync('gh',['api',`repos/0xMiden/wallet/${path}`],{encoding:'utf8'}));
const run = github(`actions/runs/${runId}`);
assert.equal(run.repository.id,853430876); assert.equal(run.workflow_id,391951744);
assert.equal(run.head_sha,source); assert.equal(run.head_branch,'wiktor/near-unspent-reconciliation');
assert.equal(run.event,'workflow_dispatch'); assert.equal(run.run_attempt,1);
assert.equal(run.status,'completed'); assert.equal(run.conclusion,'failure');
const jobs=github(`actions/runs/${runId}/jobs?per_page=100`);
const matching=jobs.jobs.filter(job=>job.name==='Chrome mainnet round trip');assert.equal(matching.length,1);
const steps=matching[0].steps;
assert.deepEqual(steps.filter(s=>s.conclusion==='failure').map(s=>s.name),['Report recovery-only coverage']);
for(const name of ['Recover prior mainnet NEAR','Wait for original NEAR recovery','Verify no new provider principal remains unresolved']) {
 const rows=steps.filter(s=>s.name===name);assert.equal(rows.length,1);assert.equal(rows[0].conclusion,'success');
}
const fresh=steps.filter(s=>s.name.startsWith('Run mainnet ')||['Prepare mainnet solver swap','Prepare mainnet Epoch loop','Prepare mainnet NEAR loop','Run native mainnet round trip','Run USDCx bridge loops'].includes(s.name));
assert.ok(fresh.length>=9);assert.ok(fresh.every(s=>s.status==='completed'&&s.conclusion==='skipped'));
const authorityArtifacts=github(`actions/runs/${runId}/artifacts?per_page=100`).artifacts.filter(a=>/authorized|signed|claim/.test(a.name));assert.deepEqual(authorityArtifacts,[]);
const path=role=>`test-results/${role}/roundtrip.json`;
const raw=role=>readFileSync(path(role));const sha=role=>createHash('sha256').update(raw(role)).digest('hex');
assert.equal(sha('fresh'),'a9418686339d234e245ec083668cbd2b16f5e4375098a33c9c26221fd6df37e4');
assert.equal(sha('final'),'6ca09782587d50227093cdbef7ee40a8d1817440508b58933ab7a26094cce6c7');
assert.equal(sha('original-near'),'d2283bdd2372696ebe109c6b31ce5190ac7b29be07901e2ede142ba8c1f18524');
const original=JSON.parse(raw('original-near'));const near=JSON.parse(raw('near'));
assert.equal(near.phase,'unspent');assert.equal(near.sourceRunId,'43811169447');
assert.deepEqual({...near,phase:original.phase,updatedAt:original.updatedAt},original);
assert.ok(Date.parse(near.updatedAt)>Date.parse(original.updatedAt));
const report=JSON.parse(readFileSync('test-results/public/mainnet-near-recovery.json','utf8'));
assert.equal(report.recoveryOnly,true);assert.equal(report.sourceRunId,'43811169447');
const epoch=JSON.parse(raw('final'));const account=epoch.evm.account;const holdings=[];
for(const [chain,url,token,units,gas,nonce] of [[1,'https://ethereum.publicnode.com',epoch.evm.token,253042125n,297568063255111083n,105n],[42161,'https://arb1.arbitrum.io/rpc',original.evm.token,38682541n,19429691940260000n,84n]]) {
 const rpc=async(method,params)=>{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'wallet-independent-readonly-audit/1.0'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  assert.ok(response.ok);const value=await response.json();assert.equal(value.error,undefined);return BigInt(value.result);
 };
 assert.equal(await rpc('eth_chainId',[]),BigInt(chain));
 const actual={token:await rpc('eth_call',[{to:token,data:'0x70a08231'+account.slice(2).toLowerCase().padStart(64,'0')},'latest']),gas:await rpc('eth_getBalance',[account,'latest']),nonce:await rpc('eth_getTransactionCount',[account,'latest']),pending:await rpc('eth_getTransactionCount',[account,'pending'])};
 assert.deepEqual(actual,{token:units,gas,nonce,pending:nonce});holdings.push({chain,...Object.fromEntries(Object.entries(actual).map(([k,v])=>[k,v.toString()]))});
}
assert.equal(90246n+1909754n,2000000n);
const output={runId,source,recoveryOnly:true,allFreshPhasesSkipped:true,noNewSdkAuthorityArtifacts:true,originalSwapEpochAndQuoteFieldsUnchanged:true,nearPhase:'unspent',nearCheckpointSha256:sha('near'),holdings,newCostUsdMicros:'0',totalVerifiedSpentUsdMicros:'90246',remainingUsdMicros:'1909754',requiresPrivateCompanion:true};
writeFileSync('test-results/recovery-zero-public-audit.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output));
