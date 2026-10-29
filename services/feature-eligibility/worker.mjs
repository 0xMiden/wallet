const NETWORKS = new Set(['mainnet', 'testnet', 'devnet']);
const CONFIG_BASE = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';
const MAXMIND_BASE = 'https://geoip.maxmind.com/geoip/v2.1/city';
const POLICY_TTL = 60_000;
const DECISION_TTL = 300_000;
const LEASE_SIZE = 4;
const FEATURES = ['wallet', 'earn', 'swap'];
const ALIASES = new Map([
  ['ny state', { country: 'US', region: 'NY' }],
  ['new york', { country: 'US', region: 'NY' }],
  ['uk', { country: 'GB' }],
  ['united kingdom', { country: 'GB' }],
  ['great britain', { country: 'GB' }]
]);

const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const failure = (status = 503, error = 'eligibility_unavailable', headers = {}) => json({ error }, status, headers);
const dayOf = value => new Date(value).toISOString().slice(0, 10);

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders }
  });
}

function integer(value, minimum, maximum) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid configuration');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error('Invalid configuration');
  return result;
}

function origins(env) {
  const values = JSON.parse(env.ALLOWED_ORIGINS ?? '[]');
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value || value.includes('*'))) {
    throw new Error('Invalid configuration');
  }
  return new Set(values);
}

function callerIp(request) {
  // Same-zone Worker subrequests can modify x-real-ip, which changes CF-Connecting-IP.
  if (!record(request.cf) || typeof request.cf.colo !== 'string' || request.headers.has('CF-Worker')) return null;
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every(part => String(Number(part)) === part && Number(part) <= 255) ? ip : null;
  }
  if (!ip.includes(':') || !/^[\da-f:.]+$/i.test(ip)) return null;
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function placeRule(phrase) {
  const normalized = phrase.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized.startsWith('block ')) throw new Error('Invalid policy');
  const name = normalized.slice(6);
  if (ALIASES.has(name)) return ALIASES.get(name);
  if (/^[a-z]{2}$/.test(name)) return { country: name.toUpperCase() };
  const parts = /^([a-z]{2})-([a-z\d]{1,3})$/.exec(name);
  if (!parts) throw new Error('Invalid policy');
  return { country: parts[1].toUpperCase(), region: parts[2].toUpperCase() };
}

function solverEnabled(value) {
  if (value === undefined) return false;
  if (!record(value)) throw new Error('Invalid policy');
  if (value.etaUrl === undefined) return false;
  if (typeof value.etaUrl !== 'string') throw new Error('Invalid policy');
  const url = new URL(value.etaUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid policy');
  return true;
}

function oneClickEnabled(value) {
  if (!record(value) || typeof value.serviceUrl !== 'string' || value.serviceUrl.length > 512) return false;
  let url;
  try {
    url = new URL(value.serviceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
  if (!Array.isArray(value.midenAssets) || value.midenAssets.length < 1 || value.midenAssets.length > 64) return false;
  const assetIds = new Set();
  const faucetIds = new Set();
  return value.midenAssets.every(asset => {
    if (
      !record(asset) ||
      typeof asset.assetId !== 'string' ||
      asset.assetId.length < 1 ||
      asset.assetId.length > 256 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(asset.assetId) ||
      typeof asset.faucetId !== 'string' ||
      !/^0x[\da-f]{30}$/i.test(asset.faucetId) ||
      !Number.isSafeInteger(asset.decimals) ||
      asset.decimals < 0 ||
      asset.decimals > 38
    ) {
      return false;
    }
    const faucetId = asset.faucetId.toLowerCase();
    if (assetIds.has(asset.assetId) || faucetIds.has(faucetId)) return false;
    assetIds.add(asset.assetId);
    faucetIds.add(faucetId);
    return true;
  });
}

function readPolicy(body, network) {
  if (!record(body) || body.network !== network || !Number.isSafeInteger(body.version) || body.version <= 0) {
    throw new Error('Invalid policy');
  }
  const features = body.features === undefined ? {} : body.features;
  if (
    !record(features) ||
    (features.earn !== undefined && typeof features.earn !== 'boolean') ||
    (features.nearIntents !== undefined && typeof features.nearIntents !== 'boolean')
  ) {
    throw new Error('Invalid policy');
  }
  const nearIntents =
    features.nearIntents === true && oneClickEnabled(record(body.swap) ? body.swap.oneClick : undefined);
  const enabled = { wallet: true, earn: features.earn === true, swap: solverEnabled(body.swap) || nearIntents };
  if (!record(body.geo) || !record(body.geo.wallet)) throw new Error('Invalid policy');
  const rules = { wallet: [], earn: [], swap: [] };
  for (const feature of FEATURES) {
    const entries = body.geo?.[feature];
    if (entries === undefined) continue;
    if (!record(entries)) throw new Error('Invalid policy');
    for (const [phrase, answer] of Object.entries(entries)) {
      if (answer !== 'yes' && answer !== 'no') throw new Error('Invalid policy');
      if (answer === 'yes') rules[feature].push(placeRule(phrase));
    }
  }
  return { network, version: body.version, enabled, rules };
}

function readPlace(body) {
  if (
    !record(body) ||
    !record(body.country) ||
    typeof body.country.iso_code !== 'string' ||
    !/^[a-z]{2}$/i.test(body.country.iso_code)
  ) {
    throw new Error('Invalid lookup');
  }
  const subdivision = Array.isArray(body.subdivisions) ? body.subdivisions[0] : undefined;
  const region =
    record(subdivision) && typeof subdivision.iso_code === 'string' && /^[a-z\d]{1,3}$/i.test(subdivision.iso_code)
      ? subdivision.iso_code.toUpperCase()
      : undefined;
  return { country: body.country.iso_code.toUpperCase(), region };
}

function allowedAt(policy, place) {
  const allowed = Object.fromEntries(
    FEATURES.map(feature => [
      feature,
      policy.enabled[feature] &&
        !policy.rules[feature].some(
          rule => rule.country === place.country && (!rule.region || !place.region || rule.region === place.region)
        )
    ])
  );
  return allowed.wallet ? allowed : { wallet: false, earn: false, swap: false };
}

async function digest(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ]);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createService({ fetchImpl = fetch, now = Date.now, timeoutMs = 5_000 } = {}) {
  const policies = new Map();

  async function policy(network) {
    let entry = policies.get(network);
    if (!entry || entry.expires <= now()) {
      const pending = fetchJson(
        `${CONFIG_BASE}/${network}.json`,
        { headers: { Accept: 'application/json' } },
        262_144
      ).then(body => readPolicy(body, network));
      entry = { expires: now() + POLICY_TTL, pending };
      policies.set(network, entry);
      pending.catch(() => {
        if (policies.get(network) === entry) policies.delete(network);
      });
    }
    return entry.pending;
  }
  function usableCache(cache, policy, identity) {
    return (
      cache?.version === policy.version &&
      cache.identity === identity &&
      cache.expires > now() &&
      record(cache.allowed) &&
      FEATURES.every(feature => typeof cache.allowed[feature] === 'boolean') &&
      (cache.allowed.wallet || (!cache.allowed.earn && !cache.allowed.swap))
    );
  }

  async function fetchJson(url, init, maxBytes, fetcher = fetchImpl, deadline = now() + timeoutMs) {
    if (now() >= deadline) throw new Error('Request expired');
    const controller = new AbortController();
    let reader;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error('Upstream unavailable'));
        },
        Math.max(0, deadline - now())
      );
    });
    try {
      return await Promise.race([
        expired,
        (async () => {
          // Workers does not support redirect: 'error'; reject redirects before reading their body.
          const response = await fetcher(url, {
            ...init,
            redirect: 'manual',
            cache: 'no-store',
            signal: controller.signal
          });
          // Only the internal lease overload is a trusted non-OK body; every other URL still fails before a read.
          const leaseOverload =
            url === 'https://eligibility.internal/lease' &&
            response.status === 503 &&
            response.headers.get('Retry-After') === '30' &&
            response.body;
          if (!leaseOverload && (!response.ok || !response.body)) throw new Error('Upstream unavailable');
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let length = 0;
          let text = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes) throw new Error('Upstream unavailable');
            text += decoder.decode(value, { stream: true });
          }
          const decoded = text + decoder.decode();
          if (response.ok) return JSON.parse(decoded);
          let body;
          try {
            body = JSON.parse(decoded);
          } catch {
            throw new Error('Upstream unavailable');
          }
          if (record(body) && Object.keys(body).length === 1 && body.error === 'overloaded') {
            throw Object.assign(new Error('Upstream unavailable'), { overloaded: true });
          }
          throw new Error('Upstream unavailable');
        })()
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
    }
  }

  async function cleanup(storage) {
    const delay = await storage.transaction(async transaction => {
      const cursor = (await transaction.get('cleanup-cursor')) ?? '';
      const entries = await transaction.list({ prefix: 'caller:', startAfter: cursor, limit: 128 });
      const expired = [...entries].filter(([, value]) => value.expires <= now()).map(([key]) => key);
      if (expired.length > 0) await transaction.delete(expired);
      if (entries.size === 128) {
        await transaction.put('cleanup-cursor', [...entries.keys()].at(-1));
        return 1_000;
      }
      await transaction.delete('cleanup-cursor');
      const remaining = await transaction.list({ prefix: 'caller:', limit: 1 });
      return remaining.size ? DECISION_TTL : null;
    });
    if (delay !== null) await storage.setAlarm(now() + delay);
  }

  async function bounded(work, deadline) {
    if (now() >= deadline) throw new Error('Request expired');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Request expired')), Math.max(0, deadline - now()));
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  class EligibilityGuard {
    constructor(state, env) {
      this.storage = state.storage;
      this.env = env;
    }

    async fetch(request) {
      try {
        const { day, deadline, leaseId, count } = await request.json();
        const pathname = new URL(request.url).pathname;
        if (
          request.method !== 'POST' ||
          (pathname !== '/reserve' && pathname !== '/lease') ||
          day !== dayOf(now()) ||
          !Number.isSafeInteger(deadline) ||
          deadline <= now() ||
          deadline > now() + 2 * timeoutMs ||
          (pathname === '/lease' &&
            (typeof leaseId !== 'string' || !/^[a-f0-9-]{36}$/.test(leaseId) || !Number.isInteger(count) || count < 1 || count > 10))
        )
          return failure();
        const limit = integer(this.env.MAXMIND_DAILY_QUERY_LIMIT, 0, 1_000_000);
        const reserved = await this.storage.transaction(async transaction => {
          let budget = await transaction.get('budget');
          if (day !== dayOf(now()) || deadline <= now()) return 0;
          if (budget?.day !== day) budget = { day, count: 0 };
          if (!Number.isSafeInteger(budget.count) || budget.count < 0) return 0;
          const leaseKey = `lease:${day}:${leaseId}`;
          if (pathname === '/lease') {
            const existing = await transaction.get(leaseKey);
            if (existing !== undefined) return existing.requested === count ? existing.granted : 0;
          }
          if (budget.count > limit) return 0;
          const granted = Math.min(pathname === '/lease' ? count : 1, limit - budget.count);
          if (granted < 1) return 0;
          // Keep the existing global-v1 budget and count every paid attempt, including failures.
          budget.count += granted;
          await transaction.put('budget', budget);
          if (pathname === '/lease') await transaction.put(leaseKey, { requested: count, granted });
          return granted;
        });
        if (pathname === '/lease' && reserved > 0 && (await this.storage.getAlarm()) === null) {
          await this.storage.setAlarm(now() + 86_400_000);
        }
        return reserved ? json(pathname === '/lease' ? { reserved: true, count: reserved } : { reserved: true }) : failure();
      } catch (error) {
        return error?.overloaded ? failure(503, 'overloaded', { 'Retry-After': '30' }) : failure();
      }
    }

    async alarm() {
      const keys = await this.storage.list({ prefix: 'lease:', limit: 128 });
      const expired = [...keys.keys()].filter(key => key.slice(6, 16) < dayOf(now()));
      if (expired.length) await this.storage.delete(expired);
      if ((await this.storage.list({ prefix: 'lease:', limit: 1 })).size) {
        await this.storage.setAlarm(now() + (keys.size === 128 && expired.length > 0 ? 1_000 : 86_400_000));
      }
    }
  }

  class CallerEligibilityGuard {
    constructor(state, env) {
      this.storage = state.storage;
      this.env = env;
      this.inflight = new Map();
      this.lease = null;
      this.leasePending = null;
    }

    async reserve(deadline) {
      const day = dayOf(now());
      if (this.lease?.day === day && this.lease.remaining > 0) {
        this.lease.remaining -= 1;
        return;
      }
      if (!this.leasePending) {
        this.leasePending = (async () => {
          const guard = this.env.ELIGIBILITY_GUARD.get(this.env.ELIGIBILITY_GUARD.idFromName('global-v1'));
          const result = await fetchJson(
            'https://eligibility.internal/lease',
            { method: 'POST', body: JSON.stringify({ day, deadline, leaseId: crypto.randomUUID(), count: LEASE_SIZE }) },
            128,
            (url, init) => guard.fetch(new Request(url, init)),
            Math.min(deadline, now() + timeoutMs)
          );
          if (!record(result) || result.reserved !== true || !Number.isInteger(result.count) || result.count < 1 || result.count > LEASE_SIZE || now() >= deadline) {
            throw new Error('Unavailable');
          }
          this.lease = { day, remaining: result.count };
        })().finally(() => { this.leasePending = null; });
      }
      await this.leasePending;
      if (this.lease.day !== day || this.lease.remaining < 1) return this.reserve(deadline);
      this.lease.remaining -= 1;
    }

    async evaluate(ip, policy, callerKey, identity, deadline) {
      const latest = await this.storage.get(callerKey);
      const cached = latest?.cache[policy.network];
      if (usableCache(cached, policy, identity)) return cached.allowed;
      if (!this.env.MAXMIND_ACCOUNT_ID || !this.env.MAXMIND_LICENSE_KEY || now() >= deadline)
        throw new Error('Unavailable');
      const authorization = `Basic ${btoa(`${this.env.MAXMIND_ACCOUNT_ID}:${this.env.MAXMIND_LICENSE_KEY}`)}`;
      await this.reserve(deadline);
      const place = readPlace(
        await fetchJson(
          `${MAXMIND_BASE}/${encodeURIComponent(ip)}`,
          {
            headers: { Accept: 'application/json', Authorization: authorization }
          },
          65_536,
          fetchImpl,
          Math.min(deadline, now() + timeoutMs)
        )
      );
      const allowed = allowedAt(policy, place);
      await this.storage.transaction(async transaction => {
        const current = (await transaction.get(callerKey)) ?? { cache: {} };
        current.cache[policy.network] = { version: policy.version, identity, allowed, expires: now() + DECISION_TTL };
        current.expires = now() + DECISION_TTL;
        await transaction.put(callerKey, current);
      });
      if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(now() + DECISION_TTL);
      return allowed;
    }

    async fetch(request) {
      try {
        const { ip, network, day, deadline } = await request.json();
        if (
          request.method !== 'POST' ||
          !NETWORKS.has(network) ||
          typeof ip !== 'string' ||
          ip.length > 45 ||
          day !== dayOf(now()) ||
          !Number.isSafeInteger(deadline) ||
          deadline <= now() ||
          deadline > now() + 2 * timeoutMs
        )
          return failure();
        if (typeof this.env.CALLER_HASH_SECRET !== 'string' || this.env.CALLER_HASH_SECRET.length < 32)
          return failure();
        const callerKey = `caller:${await digest(this.env.CALLER_HASH_SECRET, `${dayOf(now())}:${ip}`)}`;
        const caller = await this.storage.get(callerKey);
        const currentPolicy = await policy(network);
        const identity = await digest(this.env.CALLER_HASH_SECRET, JSON.stringify(currentPolicy));
        const needsLookup = FEATURES.some(feature => currentPolicy.enabled[feature] && currentPolicy.rules[feature].length > 0);
        let allowed = currentPolicy.enabled;
        if (needsLookup) {
          const cached = caller?.cache?.[network];
          if (usableCache(cached, currentPolicy, identity)) {
            allowed = cached.allowed;
          } else {
            const key = `${callerKey}:${network}:${identity}`;
            let pending = this.inflight.get(key);
            if (!pending) {
              pending = this.evaluate(ip, currentPolicy, callerKey, identity, deadline);
              this.inflight.set(key, pending);
            }
            try {
              allowed = await pending;
            } finally {
              if (this.inflight.get(key) === pending) this.inflight.delete(key);
            }
          }
        }
        return json({ network, version: currentPolicy.version, allowed });
      } catch (error) {
        return error?.overloaded ? failure(503, 'overloaded', { 'Retry-After': '30' }) : failure();
      }
    }

    async alarm() {
      await cleanup(this.storage);
    }
  }

  async function handle(request, env) {
    let finish = response => response;
    try {
      const url = new URL(request.url);
      const allowedOrigins = origins(env);
      const origin = request.headers.get('Origin');
      if (origin && !allowedOrigins.has(origin)) return failure(403, 'forbidden');
      const headers = { Vary: 'Origin' };
      if (origin) headers['Access-Control-Allow-Origin'] = origin;
      finish = response =>
        new Response(response.body, {
          status: response.status,
          headers: { ...Object.fromEntries(response.headers), ...headers }
        });
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const ready =
          env.ELIGIBILITY_GUARD &&
          env.CALLER_GUARD &&
          env.CALLER_RATE_LIMIT &&
          env.COLO_RATE_LIMIT &&
          env.MAXMIND_ACCOUNT_ID &&
          env.MAXMIND_LICENSE_KEY &&
          typeof env.CALLER_HASH_SECRET === 'string' &&
          env.CALLER_HASH_SECRET.length >= 32 &&
          integer(env.MAXMIND_DAILY_QUERY_LIMIT, 0, 1_000_000) > 0;
        return finish(ready ? json({ ready: true, revision: env.DEPLOYMENT_REVISION ?? 'unknown' }) : failure());
      }
      if (url.pathname !== '/v1/eligibility') return finish(failure(404, 'bad_request'));
      const network = url.searchParams.get('network');
      if (!NETWORKS.has(network) || [...url.searchParams].length !== 1) return finish(failure(400, 'bad_request'));
      if (request.method === 'OPTIONS') {
        if (
          request.headers.get('Access-Control-Request-Method') !== 'GET' ||
          request.headers.has('Access-Control-Request-Headers')
        ) {
          return finish(failure(403, 'forbidden'));
        }
        return finish(
          new Response(null, {
            status: 204,
            headers: { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Methods': 'GET' }
          })
        );
      }
      if (request.method !== 'GET') return finish(failure(405, 'bad_request'));
      const ip = callerIp(request);
      if (!ip) return finish(failure(400, 'bad_request'));
      if (typeof env.CALLER_HASH_SECRET !== 'string' || env.CALLER_HASH_SECRET.length < 32 || !env.ELIGIBILITY_GUARD || !env.CALLER_GUARD || !env.CALLER_RATE_LIMIT || !env.COLO_RATE_LIMIT)
        return finish(failure());
      const deadline = now() + 2 * timeoutMs;
      const day = dayOf(now());
      const caller = await digest(env.CALLER_HASH_SECRET, `${day}:${ip}`);
      const callerLimit = await env.CALLER_RATE_LIMIT.limit({ key: caller });
      if (callerLimit?.success !== true) return finish(failure(429, 'rate_limited', { 'Retry-After': '60' }));
      const coloLimit = await env.COLO_RATE_LIMIT.limit({ key: `colo:${request.cf.colo}` });
      if (coloLimit?.success !== true) return finish(failure(429, 'rate_limited', { 'Retry-After': '10' }));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const guard = env.CALLER_GUARD.get(env.CALLER_GUARD.idFromName(`cache:${request.cf.colo}`));
          const response = await bounded(
            () => guard.fetch(new Request('https://eligibility.internal/', {
              method: 'POST',
              body: JSON.stringify({ ip, network, day, deadline })
            })),
            deadline
          );
          return finish(response);
        } catch (error) {
          if (error?.overloaded) return finish(failure(503, 'overloaded', { 'Retry-After': '30' }));
          if (!error?.retryable || attempt === 1 || now() + 20 >= deadline) return finish(failure());
          await bounded(() => new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 20))), deadline);
        }
      }
      return finish(failure());
    } catch {
      return finish(failure());
    }
  }

  return { fetch: handle, EligibilityGuard, CallerEligibilityGuard };
}

const service = createService();
export const EligibilityGuard = service.EligibilityGuard;
export const CallerEligibilityGuard = service.CallerEligibilityGuard;
export default { fetch: service.fetch };
