import { chmod, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  createLocalProbeEffects,
  createProbeController,
  validateOwnershipCheck
} from './feature-eligibility-staging-probe.mjs';
import { main as recoveryMain, sanitizeEvidence } from './feature-eligibility-staging-probe-recovery.mjs';

export const ORIGINAL = Object.freeze({
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/probe-feature-eligibility.yml',
  runId: '40309563506',
  runAttempt: '1',
  sourceSha: '7781d8883e3c9db62057f4fa5d642d3af2166977'
});
const ARTIFACT = '12644191250';
const SCRIPT = `miden-elig-probe-${ORIGINAL.runId}-${ORIGINAL.runAttempt}`;
const REASONS = ['complete', 'auth', 'quota', 'network', 'invalid_response', 'ownership_mismatch', 'bounds_reached'];
const requireValue = value => {
  if (!value) throw new Error('Inspection blocked');
};
const exactKeys = (value, expected) => value && isDeepStrictEqual(Object.keys(value).sort(), expected.sort());
const identityOf = context => Object.fromEntries(Object.keys(ORIGINAL).map(key => [key, context[key]]));
const trusted = context =>
  context?.repository === ORIGINAL.repository &&
  context.workflowPath === ORIGINAL.workflowPath &&
  context.ref === 'refs/heads/main' &&
  context.eventName === 'workflow_dispatch' &&
  /^[1-9][0-9]{0,17}$/.test(context.runId) &&
  /^[1-9][0-9]{0,5}$/.test(context.runAttempt) &&
  /^[a-f0-9]{40}$/.test(context.sourceSha) &&
  context.runId !== ORIGINAL.runId;

/** A diagnostic transport exposes only five exact GET targets and one absolute deadline, including body reads. */
export function createInspectionTransport(env, { request = fetch, now = () => performance.now() } = {}) {
  requireValue(
    /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') &&
      typeof env.CLOUDFLARE_API_TOKEN === 'string' &&
      env.CLOUDFLARE_API_TOKEN.length > 0
  );
  const allowed = new Set([
    '/account',
    ...['settings', 'script-settings', 'subdomain', 'content/v2'].map(suffix => `/workers/scripts/${SCRIPT}/${suffix}`)
  ]);
  const deadline = now() + 30000;
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), 30000);
  let count = 0;
  return {
    providerAPI: async (path, init = {}) => {
      requireValue(exactKeys(init, ['method']) && init.method === 'GET' && allowed.has(path));
      requireValue(!aborter.signal.aborted && now() < deadline && count < 5);
      count++;
      const suffix = path === '/account' ? '' : path;
      const response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${suffix}`,
        {
          method: 'GET',
          redirect: 'error',
          signal: aborter.signal,
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
        }
      );
      requireValue(!aborter.signal.aborted && now() < deadline);
      return response;
    },
    count: () => count,
    expired: () => aborter.signal.aborted || now() >= deadline,
    close: () => {
      clearTimeout(timer);
      aborter.abort();
    }
  };
}

/** Compose the original manifest checks without exposing cleanup, deployment or probe requests. */
export async function inspectOriginal(prepared, manifest, priorResult, effects) {
  let outcome = { inspection: 'blocked', reason: 'ownership_mismatch' };
  try {
    requireValue(
      trusted(effects.context) &&
        exactKeys(prepared, ['identity', 'artifactId', 'workerBase64']) &&
        isDeepStrictEqual(prepared.identity, ORIGINAL) &&
        prepared.artifactId === ARTIFACT &&
        typeof prepared.workerBase64 === 'string' &&
        prepared.workerBase64.length <= 350000
    );
    const workerBytes = Buffer.from(prepared.workerBase64, 'base64');
    requireValue(
      workerBytes.length > 0 &&
        workerBytes.length <= 256 * 1024 &&
        workerBytes.toString('base64') === prepared.workerBase64 &&
        isDeepStrictEqual(manifest?.identity, ORIGINAL)
    );
    sanitizeEvidence(manifest, priorResult, workerBytes);
    outcome = await createProbeController({
      context: effects.context,
      environment: effects.environment,
      workerBytes,
      providerAPI: effects.providerAPI,
      verifyRecovery: async identity => isDeepStrictEqual(identity, ORIGINAL)
    }).inspect(manifest);
    if (effects.expired()) outcome = { inspection: 'blocked', reason: 'bounds_reached' };
  } catch {}
  return validateReceipt({
    schema: 1,
    identity: identityOf(effects.context),
    original: { ...ORIGINAL },
    artifactId: ARTIFACT,
    ...outcome,
    requests: effects.count()
  });
}

/** Only closed observations and public provenance survive into retained evidence. */
export function validateReceipt(value) {
  requireValue(
    exactKeys(value, [
      'schema',
      'identity',
      'original',
      'artifactId',
      'inspection',
      'reason',
      'requests',
      ...(Object.hasOwn(value || {}, 'ownershipCheck') ? ['ownershipCheck'] : [])
    ])
  );
  requireValue(
    value.schema === 1 &&
      isDeepStrictEqual(value.original, ORIGINAL) &&
      value.artifactId === ARTIFACT &&
      exactKeys(value.identity, Object.keys(ORIGINAL)) &&
      trusted({ ...value.identity, ref: 'refs/heads/main', eventName: 'workflow_dispatch' }) &&
      ['verified', 'absent', 'blocked'].includes(value.inspection) &&
      REASONS.includes(value.reason) &&
      Number.isInteger(value.requests) &&
      value.requests >= 0 &&
      value.requests <= 5 &&
      (value.inspection === 'blocked' ? value.reason !== 'complete' : value.reason === 'complete') &&
      (value.inspection !== 'verified' || value.requests === 5) &&
      (value.inspection !== 'absent' || value.requests === 2)
  );
  if (Object.hasOwn(value, 'ownershipCheck')) {
    validateOwnershipCheck(value.ownershipCheck);
    requireValue(value.inspection === 'blocked' && value.reason === 'ownership_mismatch');
  }
  return structuredClone(value);
}

async function readJson(path) {
  const value = await readFile(path);
  requireValue(value.length <= 65536);
  return JSON.parse(value.toString('utf8'));
}
async function privateWrite(path, value) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
}
export async function main(args, env = process.env) {
  requireValue(
    args.length === 1 &&
      ['prepare', 'inspect', 'evidence'].includes(args[0]) &&
      env.RUNNER_TEMP &&
      !env.CLEANUP_RUN_ID &&
      !env.CLEANUP_ATTEMPT
  );
  const context = createLocalProbeEffects(env).context;
  requireValue(trusted(context));
  const preparation = join(env.RUNNER_TEMP, 'probe-recovery.json');
  if (args[0] === 'prepare') {
    await recoveryMain(['prepare'], { ...env, CLEANUP_RUN_ID: ORIGINAL.runId, CLEANUP_ATTEMPT: ORIGINAL.runAttempt });
    const prepared = await readJson(preparation);
    requireValue(isDeepStrictEqual(prepared.identity, ORIGINAL) && prepared.artifactId === ARTIFACT);
    return { prepared: true };
  }
  const receiptPath = join(env.RUNNER_TEMP, 'probe-inspection.json');
  if (args[0] === 'inspect') {
    let transport;
    let receipt;
    try {
      transport = createInspectionTransport(env);
      requireValue(
        isDeepStrictEqual((await readdir(join(env.RUNNER_TEMP, 'probe-recovered'))).sort(), [
          'manifest.json',
          'result.json'
        ])
      );
      receipt = await inspectOriginal(
        await readJson(preparation),
        await readJson(join(env.RUNNER_TEMP, 'probe-recovered/manifest.json')),
        await readJson(join(env.RUNNER_TEMP, 'probe-recovered/result.json')),
        { context, environment: env, ...transport }
      );
    } catch {
      receipt = validateReceipt({
        schema: 1,
        identity: identityOf(context),
        original: { ...ORIGINAL },
        artifactId: ARTIFACT,
        inspection: 'blocked',
        reason: transport ? 'invalid_response' : 'auth',
        requests: transport?.count() || 0
      });
    } finally {
      transport?.close();
    }
    await privateWrite(receiptPath, receipt);
    return receipt;
  }
  try {
    const receipt = validateReceipt(await readJson(receiptPath));
    requireValue(isDeepStrictEqual(receipt.identity, identityOf(context)));
    const directory = join(env.RUNNER_TEMP, 'probe-inspection-evidence');
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await privateWrite(join(directory, 'inspection.json'), receipt);
    return receipt;
  } finally {
    await unlink(preparation).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then(value => {
      process.stdout.write(`${JSON.stringify(value)}\n`);
      process.exitCode = value.prepared || value.inspection !== 'blocked' ? 0 : 1;
    })
    .catch(() => {
      process.stdout.write('{"inspection":"blocked","reason":"invalid_response"}\n');
      process.exitCode = 1;
    });
}
