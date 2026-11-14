import assert from 'node:assert/strict';
import {Endpoint, NoteId, RpcClient} from '@miden-sdk/miden-sdk';
const token=process.env.GH_TOKEN;
assert.ok(token);
const response=await fetch('https://api.github.com/repos/0xMiden/wallet/actions/runs/43596925757', {headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
assert.ok(response.ok);
const run=await response.json();
assert.equal(run.status,'completed');assert.equal(run.conclusion,'failure');assert.equal(run.run_attempt,1);
assert.equal(run.head_sha,'10cb2d586e483de224ab8f342b36e47668a57968');
async function source(path) {
  const read=await fetch(`https://api.github.com/repos/0xMiden/wallet/contents/${path}?ref=${run.head_sha}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  assert.ok(read.ok);
  const file=await read.json();
  return {sha:file.sha,text:Buffer.from(file.content,'base64').toString('utf8')};
}
const constants=await source('src/lib/miden/helpers.ts');
assert.match(constants.text,/export const GUARDIAN_EXPIRATION_DELTA_BLOCKS = 180;/);
const transactions=await source('src/lib/miden/transaction/index.ts');
assert.match(transactions.text,/proposeRebased\(swapService, transaction, swapBytes, 'swap', GUARDIAN_EXPIRATION_DELTA_BLOCKS\)/);
const guardian=await source('src/lib/miden/guardian/index.ts');
assert.match(guardian.text,/feeAwareRequestBuilder\(client, this.accountId, randomFeeSalt\(\), approvalExpirationDelta\)/);
const rpc=new RpcClient(new Endpoint('https://rpc.mainnet.miden.io'));
const anchor=await rpc.getBlockHeaderByNumber(885224);
assert.equal(anchor.blockNum(),885224);
assert.ok(anchor.timestamp()*1000>Date.parse(run.updated_at));
// The pinned source proposes swaps with GUARDIAN_EXPIRATION_DELTA_BLOCKS=180; its bound block existed before this later anchor.
const approvalDeltaBlocks=180;
const expirationUpperBound=anchor.blockNum()+approvalDeltaBlocks;
const current=await rpc.getBlockHeaderByNumber();
assert.ok(current.blockNum()>expirationUpperBound);
const id='0xf41d27eecb4f68ee60bb1e7d84165f8b7e81366caaae2e054ceef6acdf63ccf5';
const notes=await rpc.getNotesById([NoteId.fromHex(id)]);
assert.equal(notes.length,0);
console.log(JSON.stringify({purpose:'read-only original Guardian swap approval lifetime bound; no authority renewal or execution',sourceRunId:run.id,sourceSha:run.head_sha,sourceEndedAt:run.updated_at,anchorBlock:anchor.blockNum(),anchorTimestamp:anchor.timestamp(),sourceConstantsBlob:constants.sha,sourceTransactionBlob:transactions.sha,sourceGuardianBlob:guardian.sha,sourceApprovalDeltaBlocks:approvalDeltaBlocks,approvalExpirationUpperBoundBlock:expirationUpperBound,observedBlock:current.blockNum(),noteId:id,noteCount:notes.length,approvalLifetimeElapsed:true,grantPersisted:false,sdkAuthorityIssued:false}));
