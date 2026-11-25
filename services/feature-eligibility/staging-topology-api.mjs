import { createHash } from 'node:crypto';

const MAX_BYTES = 1_048_576;
const MAX_CALLS = 500;
const MAX_PHASE_CALLS = 250;
const MAX_DURATION_MS = 120_000;
const CALL_TIMEOUT_MS = 5_000;
const SCRIPT = /^[a-zA-Z0-9_-]{1,63}$/;
export const TOPOLOGY_TARGET_SCRIPT = /^miden-elig-topology-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$/;
export const TOPOLOGY_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isTopologyTargetScript = value => typeof value === 'string' && TOPOLOGY_TARGET_SCRIPT.test(value);

export function isTopologyWorkersDevUrl(value) {
  if (typeof value !== 'string') return false;
  const match = /^https:\/\/([^.]+)\.([^.]+)\.workers\.dev$/.exec(value);
  return Boolean(match && isTopologyTargetScript(match[1]) && TOPOLOGY_SUBDOMAIN.test(match[2]));
}

function pathKind(path) {
  if (path === '/account') return 'account';
  if (path === '/workers/subdomain') return 'workers-subdomain';
  const subdomain = /^\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path);
  if (subdomain && isTopologyTargetScript(subdomain[1])) return 'target-subdomain';
  const content = /^\/workers\/scripts\/([^/]+)\/content\/v2$/.exec(path);
  if (content && isTopologyTargetScript(content[1])) return 'content';
  const scriptSettings = /^\/workers\/scripts\/([^/]+)\/script-settings$/.exec(path);
  if (scriptSettings && isTopologyTargetScript(scriptSettings[1])) return 'script-settings';
  const pages = /^\/workers\/(scripts|durable_objects\/namespaces)\?page=([1-9][0-9]{0,2})&per_page=(100|1000)$/.exec(
    path
  );
  if (
    pages &&
    Number(pages[2]) <= 100 &&
    ((pages[1] === 'scripts' && pages[3] === '100') || (pages[1] !== 'scripts' && pages[3] === '1000'))
  )
    return 'list';
  const settings = /^\/workers\/scripts\/([^/]+)\/settings$/.exec(path);
  return settings && SCRIPT.test(settings[1]) ? (isTopologyTargetScript(settings[1]) ? 'target' : 'settings') : null;
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const indicator = value => (typeof value === 'boolean' || value === null ? value : 'unexpected_type');

function scriptSettingsMetadata(body) {
  if (body?.success !== true || !Array.isArray(body.errors) || body.errors.length || !isPlainObject(body.result))
    return null;
  const { logpush, observability, tail_consumers: tails } = body.result;
  const result = {};
  if (logpush !== undefined) result.logpush = indicator(logpush);
  if (observability !== undefined) {
    if (!isPlainObject(observability)) result.observability = observability === null ? null : 'unexpected_type';
    else {
      const clean = {};
      if (observability.enabled !== undefined) clean.enabled = indicator(observability.enabled);
      for (const [group, keys] of [
        ['logs', ['enabled', 'invocation_logs', 'persist']],
        ['traces', ['enabled', 'persist']],
        ['issues', ['enabled']]
      ]) {
        const value = observability[group];
        if (value === undefined) continue;
        if (!isPlainObject(value)) {
          clean[group] = value === null ? null : 'unexpected_type';
          continue;
        }
        const switches = {};
        for (const key of keys) if (value[key] !== undefined) switches[key] = indicator(value[key]);
        clean[group] = switches;
      }
      result.observability = clean;
    }
  }
  if (tails !== undefined) {
    if (Array.isArray(tails)) result.tail_consumers = tails.length ? [{}] : [];
    else result.tail_consumers = tails === null ? null : 'unexpected_type';
  }
  return { success: true, errors: [], result };
}

export async function readBoundedBytes(response, { maxBytes = MAX_BYTES, signal } = {}) {
  if (!response?.body || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || signal?.aborted) return null;
  const length = response.headers?.get('content-length') ?? null;
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) return null;
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function contentDigest(response, signal) {
  if (!response.ok || response.headers.get('cf-entrypoint') !== 'staging-topology-worker.mjs') return null;
  const bytes = await readBoundedBytes(response, { signal });
  if (bytes === null) return null;
  const type = response.headers.get('content-type') || '';
  let moduleBytes = bytes;
  if (type.startsWith('multipart/form-data;')) {
    const form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
    const entries = [...form.entries()];
    if (entries.length !== 1 || entries[0][0] !== 'staging-topology-worker.mjs') return null;
    moduleBytes =
      typeof entries[0][1] === 'string'
        ? Buffer.from(entries[0][1])
        : new Uint8Array(await entries[0][1].arrayBuffer());
  } else if (!/^application\/(javascript|javascript\+module)(;|$)/.test(type)) return null;
  return { sha256: createHash('sha256').update(moduleBytes).digest('hex') };
}

function settingsMetadata(body, target) {
  if (
    body?.success !== true ||
    !Array.isArray(body.errors) ||
    body.errors.length ||
    !Array.isArray(body.result?.bindings)
  )
    return null;
  const bindings = [];
  for (const entry of body.result.bindings) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(entry.name) ||
      typeof entry.type !== 'string' ||
      !/^[a-z_]{1,64}$/.test(entry.type)
    )
      return null;
    const value = { name: entry.name, type: entry.type };
    const fields =
      entry.type === 'durable_object_namespace'
        ? ['class_name', 'namespace_id', 'script_name']
        : entry.type === 'service'
          ? ['service']
          : [];
    for (const field of fields) {
      if (entry[field] !== undefined) {
        if (typeof entry[field] !== 'string') return null;
        value[field] = entry[field];
      }
    }
    if (entry.type === 'ratelimit') {
      if (
        typeof entry.namespace_id !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(entry.namespace_id) ||
        !Number.isSafeInteger(entry.simple?.limit) ||
        !Number.isSafeInteger(entry.simple?.period)
      )
        return null;
      value.namespace_id = entry.namespace_id;
      value.simple = { limit: entry.simple.limit, period: entry.simple.period };
    }
    if (
      target &&
      ['TOPOLOGY_OWNER', 'TOPOLOGY_CONFIG_SHA', 'TOPOLOGY_SOURCE', 'TOPOLOGY_RUN_UNTIL', 'TOPOLOGY_RUN_MAX'].includes(
        entry.name
      )
    ) {
      const pattern =
        entry.name === 'TOPOLOGY_SOURCE'
          ? /^[a-f0-9]{40}$/
          : entry.name === 'TOPOLOGY_OWNER' || entry.name === 'TOPOLOGY_CONFIG_SHA'
            ? /^[a-f0-9]{64}$/
            : /^[0-9]{1,16}$/;
      if (entry.type !== 'plain_text' || typeof entry.text !== 'string' || !pattern.test(entry.text)) return null;
      value.text = entry.text;
    }
    bindings.push(value);
  }
  return { success: true, errors: [], result: { bindings } };
}

export function parseWorkersSubdomain(value, { strictKeys = false } = {}) {
  const result = value?.result;
  return value?.success === true &&
    Array.isArray(value.errors) &&
    value.errors.length === 0 &&
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (!strictKeys || Reflect.ownKeys(result).length === 1) &&
    Object.hasOwn(result, 'subdomain') &&
    typeof result.subdomain === 'string' &&
    TOPOLOGY_SUBDOMAIN.test(result.subdomain)
    ? result.subdomain
    : null;
}

export function parseWorkerSubdomainSettings(value, { strictKeys = false } = {}) {
  const result = value?.result;
  return value?.success === true &&
    Array.isArray(value.errors) &&
    value.errors.length === 0 &&
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (!strictKeys || Reflect.ownKeys(result).length === 2) &&
    Object.hasOwn(result, 'enabled') &&
    Object.hasOwn(result, 'previews_enabled') &&
    typeof result.enabled === 'boolean' &&
    typeof result.previews_enabled === 'boolean'
    ? { enabled: result.enabled, previews_enabled: result.previews_enabled }
    : null;
}

// This adapter only reads fixed provider paths; its output alone cannot authorize any mutation.
export function createTopologyReadApi({
  accountId,
  token,
  fetchImpl = fetch,
  now = () => performance.now(),
  startedAt,
  cleanupStartedAt
} = {}) {
  if (
    typeof accountId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    typeof token !== 'string' ||
    token.length < 20 ||
    token.length > 512 ||
    typeof fetchImpl !== 'function' ||
    typeof now !== 'function'
  )
    return async () => null;
  const starts = { preflight: startedAt ?? now(), cleanup: cleanupStartedAt };
  const calls = { preflight: 0, cleanup: 0 };
  return async (path, { signal, phase = 'preflight' } = {}) => {
    const kind = typeof path === 'string' ? pathKind(path) : null;
    if (
      !kind ||
      !Object.hasOwn(calls, phase) ||
      signal?.aborted ||
      calls[phase] >= MAX_PHASE_CALLS ||
      calls.preflight + calls.cleanup >= MAX_CALLS
    )
      return null;
    if (starts[phase] === undefined) starts[phase] = now();
    if (!Number.isFinite(starts[phase])) return null;
    const remaining = starts[phase] + MAX_DURATION_MS - now();
    if (!Number.isFinite(remaining) || remaining <= 0) return null;
    calls[phase]++;
    const controller = new AbortController();
    let settleAbort;
    const abortRace = new Promise(resolve => {
      settleAbort = resolve;
    });
    const abort = () => {
      controller.abort();
      settleAbort(null);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = Math.min(CALL_TIMEOUT_MS, remaining);
    let timer;
    try {
      const work = async () => {
        const suffix = kind === 'account' ? '' : path;
        const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (kind === 'content') return await contentDigest(response, controller.signal);
        const bytes = await readBoundedBytes(response, { signal: controller.signal });
        if (bytes === null) return null;
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (
          kind === 'target' &&
          response.status === 404 &&
          body?.success === false &&
          Array.isArray(body.errors) &&
          body.errors.length === 1 &&
          body.errors[0]?.code === 10007
        ) {
          return { status: 404, body: { success: false, errors: [{ code: 10007 }] } };
        }
        if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) return null;
        if (kind === 'workers-subdomain') {
          const subdomain = parseWorkersSubdomain(body);
          return subdomain ? { success: true, errors: [], result: { subdomain } } : null;
        }
        if (kind === 'target-subdomain') {
          const settings = parseWorkerSubdomainSettings(body);
          return settings ? { success: true, errors: [], result: settings } : null;
        }
        if (kind === 'settings' || kind === 'target') return settingsMetadata(body, kind === 'target');
        if (kind === 'script-settings') return scriptSettingsMetadata(body);
        return body;
      };
      timer = setTimeout(abort, timeoutMs);
      return await Promise.race([work(), abortRace]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

export function createTopologyScriptDeleter({ accountId, token, fetchImpl = fetch } = {}) {
  if (
    typeof accountId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    typeof token !== 'string' ||
    token.length < 20 ||
    token.length > 512 ||
    typeof fetchImpl !== 'function'
  )
    return async () => false;
  return async scriptName => {
    if (!isTopologyTargetScript(scriptName)) return false;
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
              redirect: 'error',
              signal: controller.signal
            }
          );
          if (!response.ok) return false;
          if (response.body === null) return true;
          const bytes = await readBoundedBytes(response, { signal: controller.signal });
          if (bytes === null) return false;
          if (bytes.length === 0) return true;
          const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          return body?.success === true && Array.isArray(body.errors) && body.errors.length === 0;
        })(),
        new Promise(resolve => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, CALL_TIMEOUT_MS);
        })
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
