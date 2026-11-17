import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { retireOriginalEpochOwnerRefund } from '../scripts/retire-original-epoch-owner-refund.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = () => ({
  original: readFileSync('test-results/epoch/roundtrip.json'),
  public: JSON.parse(readFileSync('test-results/green02-public-outcome.json', 'utf8')),
  private: JSON.parse(readFileSync('test-results/green02-private-outcome.json', 'utf8')),
  status: JSON.parse(readFileSync('test-results/green02-private-status.json', 'utf8')),
  now: 1794916800000
});
const run = a => retireOriginalEpochOwnerRefund(a.original, a.public, a.private, a.status, a.now);

test('retire exact returned-and-disabled original as cancelled without changing original authorities or inventing native completion', () => {
  const a = fixture(),
    before = hash(a.original);
  let next;
  assert.doesNotThrow(() => {
    next = run(a);
  }, 'Verified original owner refund must retire without another financial request');
  assert.equal(next.phase, 'cancelled');
  assert.equal(next.realizedCostUsdMicros, '70126');
  assert.equal(next.after.native, '18835663');
  assert.equal(next.after.evmToken, '254080030');
  assert.equal(next.after.evmNative, '297487428658860326');
  assert.equal(next.sourceRunId, '44034323631');
  assert.equal(next.consumeAuthority, undefined);
  assert.equal(next.returnNoteId, undefined);
  assert.equal(next.returnMidenTxId, undefined);
  assert.equal(next.updatedAt, '2026-11-17T12:00:00.000Z');
  const original = JSON.parse(a.original.toString()),
    restored = { ...next, phase: original.phase, updatedAt: original.updatedAt };
  for (const key of ['after', 'realizedCostUsdMicros']) {
    if (key in original) restored[key] = original[key];
    else delete restored[key];
  }
  assert.equal(
    hash(JSON.stringify(restored)),
    hash(JSON.stringify(original)),
    'Original receipt and authority fields must remain identical'
  );
  assert.equal(hash(a.original), before);
  assert.equal(before, '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1');
});

for (const [name, mutate] of [
  [
    'different checkpoint bytes',
    a => {
      a.original = Buffer.concat([a.original, Buffer.from(' ')]);
    }
  ],
  [
    'different public original run',
    a => {
      a.public.sourceRunId = '44034323630';
    }
  ],
  [
    'different private original run',
    a => {
      a.private.sourceRunId = '44034323630';
    }
  ],
  [
    'different public application',
    a => {
      a.public.applicationSource = '0'.repeat(40);
    }
  ],
  [
    'different private application',
    a => {
      a.private.applicationSource = '0'.repeat(40);
    }
  ],
  [
    'historical public SDK',
    a => {
      a.public.sdkVersion = '0.17.5';
    }
  ],
  [
    'historical private SDK',
    a => {
      a.private.sdkVersion = '0.17.5';
    }
  ],
  [
    'failed public audit',
    a => {
      a.public.status = 'failed';
    }
  ],
  [
    'failed private audit',
    a => {
      a.status.status = 'failed';
    }
  ],
  [
    'different public checkpoint digest',
    a => {
      a.public.checkpointHashes.epoch = '0'.repeat(64);
    }
  ],
  [
    'different private checkpoint digest',
    a => {
      a.private.checkpointHashes[1] = '0'.repeat(64);
    }
  ],
  [
    'unproved owner transfer',
    a => {
      a.public.originalCompactPrincipalReturnedToOriginalOwner = false;
    }
  ],
  [
    'different returned principal',
    a => {
      a.public.originalReturnedPrincipal = '980857';
    }
  ],
  [
    'remaining original SFT',
    a => {
      a.private.compactPrincipal = '1';
    }
  ],
  [
    'still-enabled original lock',
    a => {
      a.public.compactForcedWithdrawalStatus = 2;
    }
  ],
  [
    'remaining withdrawal timestamp',
    a => {
      a.private.actualWithdrawableAt = '1794911867';
    }
  ],
  [
    'live reverse intent',
    a => {
      a.public.originalIntentStatusEmpty = false;
    }
  ],
  [
    'different private owner',
    a => {
      a.private.actualOriginalPrivateAccount = 'different';
    }
  ],
  [
    'changed native holdings',
    a => {
      a.private.native = '18835662';
    }
  ],
  [
    'residual request asset',
    a => {
      a.private.request = '1';
    }
  ],
  [
    'changed returned USDC holdings',
    a => {
      a.private.ethereumToken = '254080029';
    }
  ],
  [
    'changed Ethereum gas holdings',
    a => {
      a.private.ethereumGas = '297487428658860325';
    }
  ],
  [
    'competing Ethereum nonce',
    a => {
      a.private.ethereumPendingNonce = 115;
    }
  ],
  [
    'changed Arbitrum nonce',
    a => {
      a.private.arbitrumPendingNonce = 85;
    }
  ],
  [
    'unblocked required consume',
    a => {
      a.private.requiredConsumeGuardBlocked = false;
    }
  ],
  [
    'active spending policy',
    a => {
      a.private.noLiveSpendingPolicy = false;
    }
  ],
  [
    'new authority issued',
    a => {
      a.private.noNewAuthority = false;
    }
  ],
  [
    'checkpoint mutated by private audit',
    a => {
      a.private.noCheckpointMutation = false;
    }
  ],
  [
    'different disable receipt',
    a => {
      a.public.disableHash = '0x' + '0'.repeat(64);
    }
  ],
  [
    'different portfolio costs',
    a => {
      a.private.epochAccruedCostExcludingAuthenticatedHeldPrincipalUsdMicros = '70127';
    }
  ],
  [
    'malformed portfolio costs',
    a => {
      a.public.epochAccruedCostExcludingAuthenticatedHeldPrincipalUsdMicros = '-1';
    }
  ]
])
  test(`refuse retirement for ${name} without mutating original bytes`, () => {
    const a = fixture();
    mutate(a);
    const before = hash(a.original);
    assert.throws(() => run(a));
    assert.equal(hash(a.original), before);
  });
