import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE_URL = 'http://127.0.0.1:8551';
const NETWORKS = new Set(['mainnet', 'testnet', 'devnet', 'localnet']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function fixtureEnvironment(env) {
  const requested = env.E2E_NETWORK || env.MIDEN_NETWORK || 'testnet';
  const network = requested === 'localhost' ? 'localnet' : requested;
  if (!NETWORKS.has(network)) throw new Error('Unsupported E2E fixture network');
  const selected = env.E2E_FIXTURE_NETWORKS ? env.E2E_FIXTURE_NETWORKS.split(',') : [network];
  if (
    selected.some(value => !NETWORKS.has(value)) ||
    new Set(selected).size !== selected.length ||
    !selected.includes(network)
  ) {
    throw new Error('Unsupported E2E fixture networks');
  }
  const args = ['--port', '8551', '--networks', selected.join(',')];
  const prelaunch = env.E2E_FIXTURE_PRELAUNCH_TESTNET;
  if (prelaunch !== undefined && prelaunch !== 'true' && prelaunch !== 'false') {
    throw new Error('Unsupported E2E prelaunch fixture setting');
  }
  if (prelaunch === 'true') {
    if (network !== 'testnet' || selected.length !== 1) throw new Error('Prelaunch fixture requires testnet');
    args.push('--prelaunch-testnet');
  }
  let configUrl = BASE_URL;
  if (env.MIDEN_REMOTE_CONFIG_URL) {
    const source = new URL(env.MIDEN_REMOTE_CONFIG_URL);
    const local = source.protocol === 'http:' && LOOPBACK.has(source.hostname);
    if ((!local && source.protocol !== 'https:') || source.username || source.password || source.search || source.hash) {
      throw new Error('Unsupported E2E fixture policy source');
    }
    const sourceUrl = source.href.replace(/\/+$/, '');
    if (sourceUrl !== BASE_URL) {
      args.push('--source', sourceUrl);
      if (local) {
        if (prelaunch === 'true') throw new Error('Prelaunch fixture cannot use a direct loopback policy source');
        // Existing hermetic suites start their changing config server after the build.
        args.push('--lazy-source');
        configUrl = sourceUrl;
      }
    }
  }
  return {
    args,
    env: {
      MIDEN_E2E_TEST: 'true',
      FEATURE_ELIGIBILITY_URL: `${BASE_URL}/v1/eligibility`,
      MIDEN_REMOTE_CONFIG_URL: configUrl
    }
  };
}

async function start() {
  if (!process.env.GITHUB_ENV) throw new Error('This bootstrap requires a GitHub Actions environment file');
  const plan = fixtureEnvironment(process.env);
  const logPath = join(process.env.RUNNER_TEMP || tmpdir(), `feature-eligibility-${process.pid}.log`);
  const log = openSync(logPath, 'w');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./feature-eligibility-fixture.mjs', import.meta.url)), ...plan.args], {
    env: { ...process.env, ...plan.env },
    stdio: ['ignore', log, log],
    detached: true
  });
  closeSync(log);
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', (code, signal) => { failure = new Error(`Eligibility fixture exited (${code ?? signal})`); });
  // The runner tracks the inherited child and cleans it up at the end of the job.
  child.unref();
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try {
        const response = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          appendFileSync(process.env.GITHUB_ENV, Object.entries(plan.env).map(([key, value]) => `${key}=${value}\n`).join(''));
          process.stdout.write(`Wallet eligibility fixture ready at ${BASE_URL}\n`);
          return;
        }
      } catch {}
      await wait(100);
    }
    throw new Error('Eligibility fixture did not become ready within 30 seconds');
  } catch (error) {
    child.kill('SIGTERM');
    process.stderr.write(readFileSync(logPath, 'utf8').slice(-4_000));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await start();
