import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http, isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { inspectGreen10Activation } from './green10-compact-live.mjs';
import { runGreen10Activation } from './green10-compact-activate.mjs';
import { inspectGreen10Withdrawal } from './green10-compact-withdraw.mjs';

const env = process.env;
let key = (env.E2E_MAINNET_EVM_KEY ?? '').trim().replace(/^0x/, '');
delete env.E2E_MAINNET_EVM_KEY;
try {
  assert.equal(env.GITHUB_REPOSITORY, '0xMiden/wallet');
  const stage = env.GITHUB_REF === 'refs/heads/wiktor/green10-compact-enable-once' ? 'enable' : 'withdraw';
  assert.equal(env.GITHUB_REF, `refs/heads/wiktor/green10-compact-${stage}-once`);
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/);
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), env.GITHUB_SHA);
  const dir = env.RUNNER_TEMP;
  assert.ok(dir);
  const journalPath = join(dir, 'compact-activation.json');
  const gate = join(dir, 'compact-activation-gate');
  const marker = join(dir, 'compact-activation.broadcast.once');
  assert.ok(![journalPath, gate, `${gate}.ready`, marker].some(existsSync));
  const client = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com', { retryCount: 0, timeout: 12000 }) });
  const inspect = async () => {
    const runs = JSON.parse(execFileSync('gh', ['run', 'list', '-R', '0xMiden/wallet', '-w', 'e2e-mainnet-nightly.yml', '-L', '5', '--json', 'databaseId,status,headSha'], { timeout: 15000, encoding: 'utf8' }));
    assert.equal(runs[0]?.databaseId, 44990040178);
    assert.equal(runs[0]?.headSha, '4cda551849cdc69c9990d6943696fbbbc34ac468');
    assert.ok(runs.every(run => run.status === 'completed'));
    const main = execFileSync('gh', ['api', 'repos/0xMiden/wallet/git/ref/heads/main', '--jq', '.object.sha'], { timeout: 15000, encoding: 'utf8' }).trim();
    assert.equal(main, '4cda551849cdc69c9990d6943696fbbbc34ac468');
    const checkpoint = join(dir, 'epoch.json');
    return stage === 'enable' ? inspectGreen10Activation(checkpoint, 1_510_431n) : inspectGreen10Withdrawal(checkpoint);
  };
  const hash = await runGreen10Activation({
    stage, runId: env.GITHUB_RUN_ID, source: env.GITHUB_SHA, marker, inspect,
    sign: async (transaction, owner) => {
      assert.match(key, /^[0-9a-fA-F]{64}$/);
      const signer = privateKeyToAccount(`0x${key}`);
      key = '';
      assert.ok(isAddressEqual(signer.address, owner));
      return signer.signTransaction(transaction);
    },
    acknowledge: async journal => {
      const { expiresAt } = JSON.parse(journal);
      writeFileSync(journalPath, journal, { mode: 0o600, flag: 'wx' });
      const digest = `${createHash('sha256').update(journal).digest('hex')}\n`;
      writeFileSync(`${gate}.ready`, digest, { mode: 0o600, flag: 'wx' });
      while (!existsSync(gate)) {
        assert.ok(Date.now() < expiresAt, 'Activation ACK timed out');
        await delay(250);
      }
      assert.ok(readFileSync(journalPath).equals(journal));
      return readFileSync(gate, 'utf8');
    },
    submit: serializedTransaction => client.sendRawTransaction({ serializedTransaction })
  });
  writeFileSync(join(dir, 'compact-activation-outcome.json'), JSON.stringify({ status: 'submitted', hash }) + '\n', { mode: 0o600, flag: 'wx' });
} catch {
  // Transport and signer errors can contain signed bytes; only emit a bounded outcome.
  console.error('Compact activation stopped; reconcile the immutable journal and chain before any further action.');
  process.exitCode = 1;
}
