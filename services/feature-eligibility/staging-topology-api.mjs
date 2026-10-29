const MAX_BYTES = 1_048_576;
const MAX_CALLS = 500;
const MAX_DURATION_MS = 120_000;
const CALL_TIMEOUT_MS = 5_000;
const SCRIPT = /^[a-zA-Z0-9_-]{1,63}$/;
const TARGET = /^miden-elig-topology-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$/;

function pathKind(path) {
  if (path === '/account') return 'account';
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
  return settings && SCRIPT.test(settings[1]) ? (TARGET.test(settings[1]) ? 'target' : 'settings') : null;
}

async function boundedBody(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) return null;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// This adapter only reads fixed provider paths; its output alone cannot authorize any mutation.
export function createTopologyReadApi({ accountId, token, fetchImpl = fetch, now = () => performance.now() } = {}) {
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
  const deadline = now() + MAX_DURATION_MS;
  let calls = 0;
  return async path => {
    const kind = typeof path === 'string' ? pathKind(path) : null;
    if (!kind || calls >= MAX_CALLS || now() >= deadline) return null;
    const remaining = deadline - now();
    if (!Number.isFinite(remaining) || remaining <= 0) return null;
    calls++;
    const controller = new AbortController();
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
        const body = await boundedBody(response);
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
        return body;
      };
      return await Promise.race([
        work(),
        new Promise(resolve => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, timeoutMs);
        })
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
