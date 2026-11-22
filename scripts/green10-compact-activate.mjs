import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { assertGreen10ActivationUnchanged, consumeGreen10Activation } from './green10-compact-readiness.mjs';
import { verifyGreen10ActivationEnvelope, verifyGreen10WithdrawalEnvelope } from './green10-compact-envelope.mjs';
import { assertGreen10WithdrawalUnchanged } from './green10-compact-withdraw.mjs';

export async function runGreen10Activation({ runId, source, marker, inspect, sign, acknowledge, submit, stage = 'enable' }) {
  assert.ok(stage === 'enable' || stage === 'withdraw');
  const verify = stage === 'enable' ? verifyGreen10ActivationEnvelope : verifyGreen10WithdrawalEnvelope;
  const recheck = stage === 'enable' ? assertGreen10ActivationUnchanged : assertGreen10WithdrawalUnchanged;
  assert.match(runId, /^[1-9]\d*$/);
  assert.match(source, /^[0-9a-f]{40}$/);
  assert.ok(!existsSync(marker), 'Activation attempt already consumed');
  const plan = await inspect();
  assert.ok(stage === 'enable' || plan.ready === true, 'Withdrawal must be finalized and mature before signing');
  const preparedAt = Date.now();
  const serialized = await sign(plan.transaction, plan.account);
  const signedHash = await verify(serialized, plan);
  const planBytes = JSON.stringify(plan.transaction, (_, value) => typeof value === 'bigint' ? String(value) : value);
  const journal = Buffer.from(JSON.stringify({
    stage, runId, source, checkpointSha256: plan.sha256, preparedAt,
    expiresAt: preparedAt + 240_000, signedHash, nonce: plan.transaction.nonce,
    planSha256: createHash('sha256').update(planBytes).digest('hex'), maximumCostUsdMicros: String(plan.bound)
  }) + '\n');
  const ack = await acknowledge(Buffer.from(journal));
  const bound = recheck(plan, await inspect());
  assert.ok(bound <= plan.bound, 'Recovery journal cost ceiling changed');
  assert.equal(await verify(serialized, plan), signedHash);
  consumeGreen10Activation({ marker, hash: signedHash, journal, ack, preparedAt, now: Date.now() });
  assert.equal(await submit(serialized), signedHash);
  return signedHash;
}
