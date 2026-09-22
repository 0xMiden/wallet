/**
 * Deliberate-defect harness for the Aptabase transport.
 *
 * The wallet writes its own Aptabase envelope rather than installing their SDK,
 * because their client does two things this design forbids: it reuses one
 * session id across events for four hours, and it fills `systemProps` with an
 * OS version, a locale and a device model. Both departures are only worth
 * anything if a change back to the vendor default fails the build, so this
 * applies each one — plus the ordinary leak and misconfiguration defects — and
 * checks that something goes red.
 *
 * The guard is the whole telemetry suite rather than one file, because these
 * defects are meant to be caught at different levels: the envelope mapper's own
 * unit tests, the live-wire egress boundary, and the static guarantees that read
 * the source tree. `tripped:` names which tests actually bit, so a defect caught
 * only by an unrelated assertion is visible rather than counted as a pass.
 *
 * Nothing is left on disk: every file is restored from an in-memory copy before
 * the next mutation runs.
 *
 * Usage: node scripts/telemetry-aptabase-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const APTABASE = 'src/lib/telemetry/aptabase.ts';
const SINK = 'src/lib/telemetry/sink.ts';
const SERIALIZE = 'src/lib/telemetry/serialize.ts';

const ADDRESS = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
const COMPOSITE = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe_qr7qqq9wr6w';
const NOTE_ID = '0x9f8e7d6c5b4a39281706f5e4d3c2b1a0';

// --- anchors -----------------------------------------------------------------

const PROPS_ANCHOR = '  const props: AptabaseProps = {};';
const SESSION_ANCHOR = '    sessionId: payload.flowId,';
const EVENT_NAME_ANCHOR = '    eventName: `${payload.flow}_${payload.phase}`,';
const SDK_VERSION_ANCHOR = '      sdkVersion: APTABASE_SDK_VERSION';
const IS_DEBUG_ANCHOR = "      isDebug: process.env.NODE_ENV !== 'production',";
const OS_NAME_ANCHOR = '      osName: payload.platform,';
const TIMESTAMP_ANCHOR = '    timestamp: now.toISOString(),';
const EVENT_PATH_ANCHOR = "const EVENT_PATH = '/api/v0/event';";
const KEY_PATTERN_ANCHOR = 'const APP_KEY_PATTERN = /^A-(EU|US|DEV|SH)-[A-Za-z0-9]+$/;';
const BASE_HOST_ANCHOR = "  const base = configured === '' ? REGION_HOSTS[region] : configured;";
const NO_HOST_ANCHOR = '  if (base === undefined) return null;';
const HEADERS_ANCHOR = "    headers: { 'Content-Type': 'application/json', 'App-Key': endpoint.appKey },";
const CREDENTIALS_ANCHOR = "    credentials: 'omit',";
const BODY_ANCHOR = '    body: JSON.stringify(buildEnvelope(payload))';
const UNCONFIGURED_ANCHOR = '  if (endpoint === null) return;';
const SERIALIZE_PAYLOAD_ANCHOR = `  const payload: TelemetryWirePayload = {
    phase: event.phase,`;

/** Add one field to the props the mapper builds — the open bag the type system stopped guarding. */
const withProp = line => ({
  file: APTABASE,
  find: PROPS_ANCHOR,
  replace: `  const props: AptabaseProps & Record<string, unknown> = {};\n${line}`
});

/** Add one field to systemProps. */
const withSystemProp = line => ({
  file: APTABASE,
  find: OS_NAME_ANCHOR,
  replace: `${line}\n${OS_NAME_ANCHOR}`
});

const MUTATIONS = [
  // -------------------------------------------------------------------------
  // Collision 1: sessionId. Aptabase's SDKs reuse one id for four hours.
  // -------------------------------------------------------------------------
  {
    name: 'sessionId reused across every flow (one constant session)',
    guards: 'two flows get two session ids / nothing links across flows',
    file: APTABASE,
    find: SESSION_ANCHOR,
    replace: "    sessionId: 'shared-session',"
  },
  {
    name: "Aptabase's real behaviour: the first flow's id cached and reused for every later event",
    guards: 'two flows get two session ids / nothing links across flows',
    file: APTABASE,
    find: 'export function buildEnvelope(',
    replace: `let cachedSessionId: string | undefined;\nexport function buildEnvelope(`,
    also: {
      file: APTABASE,
      find: SESSION_ANCHOR,
      replace: '    sessionId: (cachedSessionId ??= payload.flowId),'
    }
  },
  {
    name: 'sessionId derived from the device rather than the flow',
    guards: 'session id came from the payload / no persistent identifier',
    file: APTABASE,
    find: SESSION_ANCHOR,
    replace: '    sessionId: `${payload.platform}-${payload.appVersion}`,'
  },
  {
    name: 'the account address appended to the sessionId',
    guards: 'no forbidden value / session id shape',
    file: APTABASE,
    find: SESSION_ANCHOR,
    replace: '    sessionId: `${payload.flowId}-' + ADDRESS + '`,'
  },

  // -------------------------------------------------------------------------
  // Collision 2: systemProps as a device fingerprint.
  // -------------------------------------------------------------------------
  {
    name: 'locale added to systemProps',
    guards: 'never sends locale / exactly four systemProps',
    ...withSystemProp("      locale: 'en-GB',")
  },
  {
    name: 'deviceModel added to systemProps',
    guards: 'never sends deviceModel / exactly four systemProps',
    ...withSystemProp("      deviceModel: 'Pixel 8 Pro',")
  },
  {
    name: 'osVersion added to systemProps',
    guards: 'never sends osVersion / exactly four systemProps',
    ...withSystemProp("      osVersion: '17.2.1',")
  },
  {
    name: 'all three fingerprinting fields added at once ("completing" systemProps)',
    guards: 'never sends osVersion, locale or deviceModel',
    ...withSystemProp("      locale: 'en-GB',\n      osVersion: '17.2.1',\n      deviceModel: 'Pixel 8 Pro',")
  },
  {
    name: 'locale computed from the real browser API rather than hardcoded',
    guards: 'cannot compute a locale (fingerprinting-capability guard)',
    ...withSystemProp('      locale: navigator.language,')
  },
  {
    name: 'the timezone read through Intl',
    guards: 'cannot compute a locale (fingerprinting-capability guard)',
    ...withSystemProp('      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,')
  },
  {
    name: 'the user agent read into systemProps',
    guards: 'cannot compute a device model (fingerprinting-capability guard)',
    ...withSystemProp('      deviceModel: navigator.userAgent,')
  },
  {
    name: 'osName widened from our coarse platform to a free-form string',
    guards: 'no string value beyond the closed unions',
    file: APTABASE,
    find: OS_NAME_ANCHOR,
    replace: "      osName: `${payload.platform} ${navigator.userAgent}`,"
  },

  // -------------------------------------------------------------------------
  // The allowlist crossing into Aptabase's open props bag.
  // -------------------------------------------------------------------------
  {
    name: 'the payload SPREAD into props instead of mapped field by field',
    guards: 'only allowlisted prop keys / exactly three prop keys on the wire',
    file: APTABASE,
    find: PROPS_ANCHOR,
    replace: '  const props: AptabaseProps & Record<string, unknown> = { ...payload };'
  },
  {
    name: 'the payload Object.assign-ed into props',
    guards: 'only allowlisted prop keys / exactly three prop keys on the wire',
    file: APTABASE,
    find: PROPS_ANCHOR,
    replace: '  const props: AptabaseProps & Record<string, unknown> = Object.assign({}, payload);'
  },
  {
    name: 'the payload keys iterated into props',
    guards: 'only allowlisted prop keys / exactly three prop keys on the wire',
    file: APTABASE,
    find: PROPS_ANCHOR,
    replace: `  const props: AptabaseProps & Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) props[key] = value;`
  },
  // The corpus of leaked VALUES — every Miden secret in every encoding — is
  // driven through `props` by `scripts/telemetry-egress-mutations.mjs`, whose
  // payload-leak family was retargeted here when the mapper became the last
  // thing before `fetch`. Not repeated: two lists of the same leaks drift.
  {
    name: 'an error string smuggled into props',
    guards: 'no string value beyond the closed unions',
    ...withProp("  props.detail = 'proving failed for " + ADDRESS + "';")
  },
  {
    name: 'the SDK version replaced with a free-form string carrying an address',
    guards: 'no string value beyond the closed unions',
    file: APTABASE,
    find: SDK_VERSION_ANCHOR,
    replace: "      sdkVersion: 'built for " + ADDRESS + "'"
  },
  {
    name: 'isDebug replaced with an identifying string',
    guards: 'no nested structure / no string value beyond the closed unions',
    file: APTABASE,
    find: IS_DEBUG_ANCHOR,
    replace: "      isDebug: `debug-" + COMPOSITE + "`,"
  },
  {
    name: 'durationMs dropped from props',
    guards: 'exactly three prop keys on the wire',
    file: APTABASE,
    find: '  if (payload.durationMs !== undefined) props.durationMs = payload.durationMs;',
    replace: ''
  },
  {
    name: 'errorKind dropped from props',
    guards: 'exactly three prop keys on the wire',
    file: APTABASE,
    find: '  if (payload.errorKind !== undefined) props.errorKind = payload.errorKind;',
    replace: ''
  },

  // -------------------------------------------------------------------------
  // eventName.
  // -------------------------------------------------------------------------
  {
    name: 'eventName built from free text instead of the closed unions',
    guards: 'no string value beyond the closed unions / names every flow',
    file: APTABASE,
    find: EVENT_NAME_ANCHOR,
    replace: "    eventName: `${payload.flow} for " + ADDRESS + "`,"
  },
  {
    name: 'the flow dropped from eventName, so every event is named the same',
    guards: 'names every flow on both phases',
    file: APTABASE,
    find: EVENT_NAME_ANCHOR,
    replace: '    eventName: `wallet_${payload.phase}`,'
  },
  {
    name: 'the phase dropped from eventName, so starts and ends are indistinguishable',
    guards: 'names every flow on both phases',
    file: APTABASE,
    find: EVENT_NAME_ANCHOR,
    replace: '    eventName: `${payload.flow}_started`,'
  },

  // -------------------------------------------------------------------------
  // The envelope and the endpoint.
  // -------------------------------------------------------------------------
  {
    name: 'the timestamp replaced with a free-form string',
    guards: 'ISO-8601 timestamp',
    file: APTABASE,
    find: TIMESTAMP_ANCHOR,
    replace: "    timestamp: `sent from " + ADDRESS + "`,"
  },
  {
    name: 'switched to the 25-event batch endpoint',
    guards: 'one event per request, never the batch endpoint',
    file: APTABASE,
    find: EVENT_PATH_ANCHOR,
    replace: "const EVENT_PATH = '/api/v0/events';"
  },
  {
    name: 'events batched into an array body',
    guards: 'one event per request, never the batch endpoint',
    file: SINK,
    find: BODY_ANCHOR,
    replace: '    body: JSON.stringify([buildEnvelope(payload)])'
  },
  {
    name: 'the App-Key header dropped',
    guards: 'authenticates with the App-Key header',
    file: SINK,
    find: HEADERS_ANCHOR,
    replace: "    headers: { 'Content-Type': 'application/json' },"
  },
  {
    name: 'credentials no longer omitted, so a cookie could ride along',
    guards: 'omits credentials',
    file: SINK,
    find: CREDENTIALS_ANCHOR,
    replace: ''
  },
  {
    name: 'the region derivation inverted (an EU key sends to the US)',
    guards: 'derives the EU host from an A-EU key / reaches only the derived endpoint',
    file: APTABASE,
    find: `  EU: 'https://eu.aptabase.com',
  US: 'https://us.aptabase.com'`,
    replace: `  EU: 'https://us.aptabase.com',
  US: 'https://eu.aptabase.com'`
  },
  {
    name: 'a self-hosted key with no host silently defaults to the EU host',
    guards: 'requires an explicit host for a self-hosted key',
    file: APTABASE,
    find: BASE_HOST_ANCHOR,
    replace: "  const base = configured === '' ? (REGION_HOSTS[region] ?? 'https://eu.aptabase.com') : configured;"
  },
  {
    name: 'a missing host no longer disables sending',
    guards: 'requires an explicit host for a self-hosted / development key',
    file: APTABASE,
    find: NO_HOST_ANCHOR,
    replace: "  if (base === undefined) return { url: '/api/v0/event', appKey: key };"
  },
  {
    name: 'the app-key pattern loosened to accept anything',
    guards: 'disables sending for a malformed app key',
    file: APTABASE,
    find: KEY_PATTERN_ANCHOR,
    replace: 'const APP_KEY_PATTERN = /^(.*)$/;'
  },
  {
    name: 'a malformed configuration throws instead of disabling',
    guards: 'never throws / sendEvent never rejects',
    file: APTABASE,
    find: '  if (region === undefined) return null;',
    replace: "  if (region === undefined) throw new Error(`unusable Aptabase app key: ${appKey}`);"
  },
  {
    name: 'an unconfigured build sends to a relative URL instead of nothing',
    guards: 'sends nothing when the app key is unset',
    file: SINK,
    find: UNCONFIGURED_ANCHOR,
    replace: "  if (endpoint === null) { await fetch('/api/v0/event', { method: 'POST' }); return; }"
  },
  {
    name: 'sending silenced entirely (anti-vacuity: nothing reaches the wire)',
    guards: 'sends something at all',
    file: SINK,
    find: UNCONFIGURED_ANCHOR,
    replace: '  if (endpoint !== null) return;'
  },

  // -------------------------------------------------------------------------
  // Defence in depth: the mapper is a SECOND allowlist behind the wire type.
  // -------------------------------------------------------------------------
  {
    name: 'a note id added to the serialized payload but not to the mapper',
    guards: 'exactly the allowlisted keys (serializer level)',
    // Worth keeping even though it produces no egress: because the mapper
    // copies by name, this field reaches no envelope at all, so the EGRESS
    // assertions cannot see it and the serializer's own allowlist is the only
    // thing standing there. This proves that layer still bites on its own —
    // and `tripped:` naming only serializer tests is the evidence for it.
    file: SERIALIZE,
    find: SERIALIZE_PAYLOAD_ANCHOR,
    replace: `  const payload: TelemetryWirePayload & Record<string, unknown> = {
    noteId: '${NOTE_ID}',
    phase: event.phase,`
  }
];

const GUARD = 'src/lib/telemetry';

function apply(edit, backups) {
  const path = resolve(ROOT, edit.file);
  if (!backups.has(path)) backups.set(path, readFileSync(path, 'utf8'));
  const current = readFileSync(path, 'utf8');
  if (!current.includes(edit.find)) {
    throw new Error(`anchor not found in ${edit.file}:\n${edit.find}`);
  }
  writeFileSync(path, current.replace(edit.find, edit.replace));
}

function restore(backups) {
  for (const [path, contents] of backups) writeFileSync(path, contents);
}

function runGuard() {
  try {
    execFileSync('node', ['node_modules/.bin/jest', GUARD], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    return { failed: false, output: '' };
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const failingTests = output => [
  ...new Set([...output.matchAll(/●\s+(.+?)\s+›\s+(.+)/g)].map(match => `${match[1]} › ${match[2]}`.trim()))
];

// A red baseline reports every mutation as killed, which is the one way this
// harness could claim a perfect score while proving nothing.
const baseline = runGuard();
if (baseline.failed) {
  console.error('BASELINE IS RED — every mutation below would report as killed for the wrong reason.');
  console.error(baseline.output);
  process.exit(1);
}
console.log('baseline: green\n');

let killed = 0;
let survived = 0;
let equivalent = 0;
let broken = 0;

for (const [index, mutation] of MUTATIONS.entries()) {
  const backups = new Map();
  const label = `${String(index + 1).padStart(2, '0')}. ${mutation.name}`;
  let result;
  try {
    apply(mutation, backups);
    if (mutation.also) apply(mutation.also, backups);
    result = runGuard();
  } catch (error) {
    // BROKEN is a harness failure, not a score: an anchor that has drifted
    // leaves its guarantee UNPROVEN while reporting nothing alarming, which is
    // exactly how a campaign rots. It exits non-zero alongside SURVIVED.
    broken++;
    console.log(`BROKEN   ${label}\n         ${error.message.split('\n')[0]}`);
    continue;
  } finally {
    restore(backups);
  }

  if (result.failed) {
    killed++;
    console.log(`KILLED   ${label}\n         guard: ${mutation.guards}\n         tripped: ${failingTests(result.output).join('; ')}`);
  } else if (mutation.equivalent) {
    equivalent++;
    console.log(`NO EGRESS ${label}\n         nothing reaches the wire: ${mutation.equivalent}`);
  } else {
    survived++;
    console.log(`SURVIVED ${label}\n         guard that should have caught it: ${mutation.guards}`);
  }
}

console.log(
  `\n${killed} killed, ${equivalent} equivalent, ${survived} survived, ${broken} broken anchors, ${MUTATIONS.length} total`
);
process.exit(survived === 0 && broken === 0 ? 0 : 1);
