import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { assertGreen10ActivationUnchanged, consumeGreen10Activation } from './green10-compact-readiness.mjs';
import { verifyGreen10ActivationEnvelope } from './green10-compact-envelope.mjs';

export async function runGreen10Activation({ runId, source, marker, inspect, sign, acknowledge, submit }) {
  assert.match(runId, /^[1-9]\d*$/);
  assert.match(source, /^[0-9a-f]{40}$/);
  assert.ok(!existsSync(marker), 'Activation attempt already consumed');
  const plan = await inspect();
  const preparedAt = Date.now();
  const serialized = await sign(plan.transaction, plan.account);
  const signedHash = await verifyGreen10ActivationEnvelope(serialized, plan);
  const planBytes = JSON.stringify(plan.transaction, (_, value) => typeof value === 'bigint' ? String(value) : value);
  const journal = Buffer.from(JSON.stringify({
    stage: 'enable', runId, source, checkpointSha256: plan.sha256, preparedAt,
    expiresAt: preparedAt + 240_000, signedHash, nonce: plan.transaction.nonce,
    planSha256: createHash('sha256').update(planBytes).digest('hex'), maximumCostUsdMicros: String(plan.bound)
  }) + '\n');
  const ack = await acknowledge(Buffer.from(journal));
  const bound = assertGreen10ActivationUnchanged(plan, await inspect());
  assert.ok(bound <= plan.bound, 'Activation journal cost ceiling changed');
  assert.equal(await verifyGreen10ActivationEnvelope(serialized, plan), signedHash);
  consumeGreen10Activation({ marker, hash: signedHash, journal, ack, preparedAt, now: Date.now() });
  assert.equal(await submit(serialized), signedHash);
  return signedHash;
}
