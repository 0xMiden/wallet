import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData } from 'viem';
import { COMPACT_ABI } from '../node_modules/@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import {
  compactRecoveryIntent,
  assertCompactRecoveryFees,
  acknowledgeCompactRecovery,
  consumeCompactRecoveryAttempt
} from '../scripts/mainnet-compact-recovery-guard.mjs';
const owner = '0xc3B89CeCb0c5C3442A7DBCbBE379351C6bDfF836',
  compact = '0x00000000000000171ede64904551eeDF3C6C9788',
  token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  id = BigInt('0x407c50057d83bedfcde2fb0ca0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const hash = `0x${'11'.repeat(32)}`;
function journalFixture() {
  const binding = { runId: '123456', sourceSha: 'da954b1d3c65d5d0c54cfdeb5db6a35fc1480e49', stage: 'enable' };
  const journal = {
    version: 1,
    sourceRunId: '44034323631',
    checkpointSha256: '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1',
    ...binding,
    preparedAt: 1000,
    expiresAt: 241000,
    signedHash: hash
  };
  return { binding, journal, bytes: JSON.stringify(journal) };
}
test('accepts only this execution original-case byte-identical immutable ACK before expiry', () => {
  const f = journalFixture();
  assert.doesNotThrow(() => acknowledgeCompactRecovery(f.bytes, f.bytes, f.binding, 2000));
});
for (const [name, change] of [
  [
    'another run',
    f => {
      f.binding.runId = '123457';
    }
  ],
  [
    'another source',
    f => {
      f.binding.sourceSha = '00'.repeat(20);
    }
  ],
  [
    'another operation',
    f => {
      f.binding.stage = 'withdraw';
    }
  ],
  [
    'another original checkpoint',
    f => {
      f.journal.checkpointSha256 = 'wrong';
      f.bytes = JSON.stringify(f.journal);
    }
  ],
  [
    'expired acknowledgement',
    f => {
      f.now = 241000;
    }
  ],
  [
    'clock regression',
    f => {
      f.now = 999;
    }
  ],
  [
    'renewed authority window',
    f => {
      f.journal.expiresAt++;
      f.bytes = JSON.stringify(f.journal);
    }
  ],
  [
    'unbound signed transaction hash',
    f => {
      f.journal.signedHash = '0x00';
      f.bytes = JSON.stringify(f.journal);
    }
  ]
])
  test(`ACK rejects ${name}`, () => {
    const f = journalFixture();
    change(f);
    assert.throws(() => acknowledgeCompactRecovery(f.bytes, f.bytes, f.binding, f.now ?? 2000));
  });
test('ACK rejects changed downloaded bytes, even harmless reserialization', () => {
  const f = journalFixture();
  assert.throws(() => acknowledgeCompactRecovery(f.bytes, JSON.stringify(f.journal, null, 2), f.binding, 2000));
});
test('consumes a durable original attempt marker once and never overwrites it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-once-'));
  try {
    const path = join(dir, 'enable.once');
    assert.doesNotThrow(() => consumeCompactRecoveryAttempt(path, hash));
    assert.equal(readFileSync(path, 'utf8'), `${hash}\n`);
    assert.throws(() => consumeCompactRecoveryAttempt(path, `0x${'22'.repeat(32)}`));
    assert.equal(readFileSync(path, 'utf8'), `${hash}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture(stage = 'enable') {
  const original = {
    checkpointSha256: '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1',
    checkpoint: {
      sourceRunId: '44034323631',
      authorizationRunId: '44034323631',
      phase: 'recovery-required',
      evm: { chainId: 1, account: owner, compact, token },
      returnAmount: '980858',
      reverseAuthority: { lockTag: '0x407c50057d83bedfcde2fb0c' }
    }
  };
  const live = {
    chainId: 1,
    owner,
    compact,
    tokenId: id,
    balance: stage === 'disable' ? 0n : 980858n,
    latestNonce: stage === 'enable' ? 111 : stage === 'withdraw' ? 112 : 113,
    pendingNonce: stage === 'enable' ? 111 : stage === 'withdraw' ? 112 : 113,
    status: stage === 'enable' ? 0 : 2,
    withdrawableAt: stage === 'enable' ? 0n : 20000n,
    blockTimestamp: 20000n,
    observedAt: 30000,
    now: 30000,
    remainingUsdMicros: 1788388n
  };
  const prior =
    stage === 'enable'
      ? undefined
      : {
          enable: { hash, nonce: 111, success: true, owner, compact, tokenId: id, withdrawableAt: 20000n },
          ...(stage === 'disable'
            ? {
                withdraw: {
                  hash: `0x${'22'.repeat(32)}`,
                  nonce: 112,
                  success: true,
                  owner,
                  recipient: owner,
                  compact,
                  tokenId: id,
                  amount: 980858n
                }
              }
            : {})
        };
  return { original, live, prior };
}
for (const stage of ['enable', 'withdraw', 'disable'])
  test(`permits exact original-only ${stage}, never original intent/deposit replay`, () => {
    const f = fixture(stage);
    let tx;
    assert.doesNotThrow(() => {
      tx = compactRecoveryIntent(stage, f.original, f.live, f.prior);
    }, 'exact original owner-only recovery must be supported');
    assert.equal(tx.chainId, 1);
    assert.equal(tx.account.toLowerCase(), owner.toLowerCase());
    assert.equal(tx.to.toLowerCase(), compact.toLowerCase());
    assert.equal(tx.value, 0n);
    assert.equal(tx.nonce, f.live.latestNonce);
    const decoded = decodeFunctionData({ abi: COMPACT_ABI, data: tx.data });
    assert.equal(
      decoded.functionName,
      { enable: 'enableForcedWithdrawal', withdraw: 'forcedWithdrawal', disable: 'disableForcedWithdrawal' }[stage]
    );
    assert.equal(decoded.args[0], id);
    if (stage === 'withdraw') {
      assert.equal(decoded.args[1].toLowerCase(), owner.toLowerCase());
      assert.equal(decoded.args[2], 980858n);
    }
  });
for (const [name, change] of [
  [
    'another original digest',
    f => {
      f.original.checkpointSha256 = 'wrong';
    }
  ],
  [
    'another producer',
    f => {
      f.original.checkpoint.sourceRunId = 'other';
    }
  ],
  [
    'another owner',
    f => {
      f.live.owner = '0x0000000000000000000000000000000000000001';
    }
  ],
  [
    'another chain',
    f => {
      f.live.chainId = 42161;
    }
  ],
  [
    'another contract',
    f => {
      f.live.compact = token;
    }
  ],
  [
    'another token ID',
    f => {
      f.live.tokenId = id + 1n;
    }
  ],
  [
    'altered original principal',
    f => {
      f.original.checkpoint.returnAmount = '980859';
    }
  ],
  [
    'unexplained balance',
    f => {
      f.live.balance = 980857n;
    }
  ],
  [
    'unrelated pending nonce',
    f => {
      f.live.pendingNonce = 112;
    }
  ],
  [
    'used or changed original recovery nonce',
    f => {
      f.live.latestNonce = f.live.pendingNonce = 112;
    }
  ],
  [
    'already enabled operation',
    f => {
      f.live.status = 1;
    }
  ],
  [
    'stale live facts',
    f => {
      f.live.now = 150001;
    }
  ],
  [
    'unreconciled original native claim',
    f => {
      f.original.checkpoint.consumeAuthority = { nonce: 'already-issued' };
    }
  ],
  [
    'missing original remaining cap',
    f => {
      f.live.remainingUsdMicros = 0n;
    }
  ]
])
  test(`rejects ${name} before signing`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => compactRecoveryIntent('enable', f.original, f.live, f.prior));
  });
test('rejects unsupported stage rather than funding a new loop', () => {
  const f = fixture();
  assert.throws(() => compactRecoveryIntent('deposit', f.original, f.live, f.prior));
});
test('withdrawal waits for on-chain time, not local wall clock', () => {
  const f = fixture('withdraw');
  f.live.blockTimestamp = 19999n;
  assert.throws(() => compactRecoveryIntent('withdraw', f.original, f.live, f.prior));
});
test('withdrawal requires confirmed original initializer, never a guessed nonce', () => {
  const f = fixture('withdraw');
  f.prior.enable.success = false;
  assert.throws(() => compactRecoveryIntent('withdraw', f.original, f.live, f.prior));
});
test('disable requires exact confirmed return to original owner and no remaining escrow', () => {
  const f = fixture('disable');
  f.prior.withdraw.recipient = token;
  assert.throws(() => compactRecoveryIntent('disable', f.original, f.live, f.prior));
});
test('bounds maximum gas using frozen conservative valuation and original remaining allowance', () => {
  const tx = { gas: 80000n, maxFeePerGas: 500000000n, maxPriorityFeePerGas: 100000000n };
  let cost;
  assert.doesNotThrow(() => {
    cost = assertCompactRecoveryFees(tx, 2000000000n, 1788388n);
  }, 'bounded original recovery gas must be supported');
  assert.equal(cost, 80000n);
});
for (const [name, tx, price, remaining] of [
  [
    'over per-stage fee cap',
    { gas: 80000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 100000000n },
    2000000000n,
    1788388n
  ],
  [
    'over remaining original allowance',
    { gas: 80000n, maxFeePerGas: 500000000n, maxPriorityFeePerGas: 100000000n },
    2000000000n,
    79999n
  ],
  [
    'priority above maximum',
    { gas: 80000n, maxFeePerGas: 500000000n, maxPriorityFeePerGas: 600000000n },
    2000000000n,
    1788388n
  ],
  ['unbounded gas', { gas: 80001n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }, 2000000000n, 1788388n],
  ['missing price', { gas: 80000n, maxFeePerGas: 500000000n, maxPriorityFeePerGas: 100000000n }, 0n, 1788388n]
])
  test(`refuses ${name}`, () => assert.throws(() => assertCompactRecoveryFees(tx, price, remaining)));
