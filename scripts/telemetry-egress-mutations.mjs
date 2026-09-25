/**
 * Deliberate-leak harness for the telemetry egress guard.
 *
 * Applies one leak at a time to the production telemetry modules, runs the
 * egress guard against it, and reports whether the guard caught it. A guard
 * that cannot fail manufactures confidence, so this exists to prove each
 * guarantee bites. Nothing here is left on disk: every file is restored from an
 * in-memory copy before the next mutation.
 *
 * Usage: node scripts/telemetry-egress-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SERIALIZE = 'src/lib/telemetry/serialize.ts';
const SINK = 'src/lib/telemetry/sink.ts';
const REPORT_FLOW = 'src/lib/telemetry/report-flow.ts';
const CRASH = 'src/lib/telemetry/crash.ts';
const REDACT = 'src/lib/telemetry/redact.ts';

const ADDRESS = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
const COMPOSITE = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe_qr7qqq9wr6w';
const NOTE_ID = '0x9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const AMOUNT = '4242424242';
const PHRASE_HEAD = 'avoid leave side crush';

const PAYLOAD_ANCHOR = `  const payload: TelemetryWirePayload = {
    phase: event.phase,`;

const APTABASE = 'src/lib/telemetry/aptabase.ts';
const PROPS_ANCHOR = '  const props: AptabaseProps = {};';

/**
 * Put one leaked value where it will actually reach the wire.
 *
 * This used to inject into `serializeEvent`, which was the last thing before
 * `fetch`. It no longer is: `aptabase.ts` maps the allowlisted payload onto
 * Aptabase's envelope field by field, so a field added upstream is simply not
 * copied and never leaves. Injecting there now would report SURVIVED for a
 * mutation that produces no egress at all — a false negative that reads as a
 * hole in the guard.
 *
 * So the leaks go into Aptabase's `props`, which is the open object the wire
 * type can no longer protect and therefore the point where a leak is now
 * possible. The serializer's own allowlist is still asserted, by
 * `serialize.test.ts` and by the mutations in
 * `scripts/telemetry-aptabase-mutations.mjs`.
 */
const withPayloadField = line => ({
  file: APTABASE,
  find: PROPS_ANCHOR,
  replace: `  const props: AptabaseProps & Record<string, unknown> = {};\n${line}`
});

/** Each entry: a single leak, and the guarantee it is meant to trip. */
const MUTATIONS = [
  // --- product-event payload contents ---
  {
    name: 'note id added to the wire payload',
    guards: 'no forbidden value / allowlisted keys',
    ...withPayloadField(`  props.noteId = '${NOTE_ID}';`)
  },
  {
    name: 'account address added to the wire payload',
    guards: 'no forbidden value / allowlisted keys',
    ...withPayloadField(`  props.account = '${ADDRESS}';`)
  },
  {
    name: 'composite publicKey added to the wire payload',
    guards: 'no forbidden value / allowlisted keys',
    ...withPayloadField(`  props.publicKey = '${COMPOSITE}';`)
  },
  {
    name: 'amount added to the wire payload',
    guards: 'no forbidden value / allowlisted keys',
    ...withPayloadField(`  props.amount = '${AMOUNT}';`)
  },
  {
    name: 'amount added as a NUMBER, not a string',
    guards: 'no forbidden value',
    ...withPayloadField(`  props.amount = ${AMOUNT};`)
  },
  {
    name: 'four consecutive recovery-phrase words added',
    guards: 'no forbidden value (word-window probes)',
    ...withPayloadField(`  props.hint = '${PHRASE_HEAD}';`)
  },
  {
    name: 'address added BASE64-encoded',
    guards: 'no forbidden value (base64 variant)',
    ...withPayloadField(`  props.blob = '${Buffer.from(ADDRESS).toString('base64')}';`)
  },
  {
    name: 'address added BASE64URL-encoded',
    guards: 'no forbidden value (base64url variant)',
    ...withPayloadField(`  props.blob = '${Buffer.from(ADDRESS).toString('base64url')}';`)
  },
  {
    name: 'address added PERCENT-encoded',
    guards: 'no forbidden value (percent variant)',
    ...withPayloadField(
      `  props.blob = '${[...Buffer.from(ADDRESS)].map(b => `%${b.toString(16).padStart(2, '0')}`).join('')}';`
    )
  },
  {
    name: 'address added \\uXXXX-escaped',
    guards: 'no forbidden value (unicode-escape variant)',
    ...withPayloadField(
      `  props.blob = '${[...ADDRESS].map(c => `\\\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}';`
    )
  },
  {
    name: 'address added HEX-encoded',
    guards: 'no forbidden value (hex variant)',
    ...withPayloadField(`  props.blob = '${Buffer.from(ADDRESS).toString('hex')}';`)
  },
  {
    name: 'benign extra key (locale) added to the wire payload',
    guards: 'exactly the allowlisted keys',
    ...withPayloadField(`  props.locale = 'en-GB';`)
  },
  {
    name: 'nested object added to the wire payload',
    guards: 'no nested structure',
    ...withPayloadField(`  props.detail = { address: '${ADDRESS}' };`)
  },
  {
    name: 'the event spread into the payload instead of copied field by field',
    guards: 'exactly the allowlisted keys',
    // Both allowlists broken at once, which is what it now takes for a stray
    // field to travel: the serializer grows one, and the mapper stops copying
    // by name. Either alone produces no egress — see the harness note above.
    file: SERIALIZE,
    find: PAYLOAD_ANCHOR,
    replace: `  const payload: TelemetryWirePayload & Record<string, unknown> = {
    ...JSON.parse(JSON.stringify({ note: '${NOTE_ID}' })),
    phase: event.phase,`,
    also: {
      file: APTABASE,
      find: PROPS_ANCHOR,
      replace: '  const props: AptabaseProps & Record<string, unknown> = { ...payload };'
    }
  },
  {
    name: 'durationMs dropped from the payload',
    guards: 'every prop key derives from the allowlist, and all three are emitted',
    file: SERIALIZE,
    find: `    payload.durationMs = Math.round(event.durationMs);`,
    replace: ``
  },
  {
    name: 'appVersion replaced with a free-form string',
    guards: 'no string value beyond the closed unions',
    file: SERIALIZE,
    find: `    appVersion: context.appVersion,`,
    replace: `    appVersion: 'built for ${ADDRESS}',`
  },
  {
    name: 'result replaced with a free-form string',
    guards: 'no string value beyond the closed unions',
    file: SERIALIZE,
    find: `    payload.result = event.result;`,
    replace: `    payload.result = JSON.parse(JSON.stringify('failed to send to ${ADDRESS}'));`
  },

  // --- flow id ---
  {
    name: 'the account address appended to the ephemeral flowId',
    guards: 'no forbidden value / flowId shape',
    file: REPORT_FLOW,
    find: `  const flowId = nanoid();`,
    replace: `  const flowId = \`\${nanoid()}-${ADDRESS}\`;`
  },

  // --- consent gate + egress destination ---
  {
    name: 'the consent gate removed from sendEvent',
    guards: 'nothing at all with consent off',
    file: SINK,
    find: `    if (!(await isTelemetryEnabledAsync())) return;`,
    replace: `    await isTelemetryEnabledAsync();`
  },
  {
    name: 'a second analytics host mirrored alongside the ingest endpoint',
    guards: 'reaches only the configured ingest endpoint',
    file: SINK,
    find: `    const transport = transportOverride ?? defaultTransport;`,
    replace: `    await fetch('https://analytics.example.com/collect', { method: 'POST', body: JSON.stringify(payload) });
    const transport = transportOverride ?? defaultTransport;`
  },
  {
    name: 'reporting silenced entirely (anti-vacuity: nothing is sent)',
    guards: 'sends something at all',
    file: REPORT_FLOW,
    find: `      await request({ type: WalletMessageType.ReportTelemetryEventRequest, event });`,
    replace: `      void request;
      void event;`
  },
  {
    name: 'the cancel path silenced (anti-vacuity: an outcome stops being reported)',
    guards: 'reports every flow on every path',
    file: REPORT_FLOW,
    find: `    cancel: () => end('cancelled'),`,
    replace: `    cancel: () => undefined,`
  },

  // --- crash reports ---
  {
    name: 'the ORIGINAL error captured instead of the rebuilt one',
    guards: 'crash: no forbidden value from the cause chain',
    file: CRASH,
    find: `      target.captureException(reportable);`,
    replace: `      target.captureException(error);`
  },
  {
    name: 'the poisoned cause chain kept on the rebuilt error',
    guards: 'crash: no forbidden value from the cause chain',
    file: CRASH,
    find: `      const reportable = new Error(safeMessage);`,
    replace: `      const reportable = new Error(safeMessage, { cause: error });`
  },
  {
    name: 'the message scrubber neutered',
    guards: 'crash: no forbidden value',
    file: CRASH,
    find: `      const safeMessage = redactMessage(error.message, WORDLIST) ?? REDACTED;`,
    replace: `      const safeMessage = error.message;
      void redactMessage;
      void REDACTED;`
  },
  {
    name: 'the stack scrubber neutered',
    guards: 'crash: no forbidden value from a poisoned stack',
    file: CRASH,
    find: `  return [header, ...lines.slice(firstFrame).map(line => redactText(line, WORDLIST))].join('\\n');`,
    replace: `  return [header, ...lines.slice(firstFrame)].join('\\n');`
  },
  {
    name: 'the stack header kept verbatim instead of rebuilt',
    guards: 'crash: no forbidden value from a poisoned stack',
    // Sentry's stack parser keeps only the lines that parse as frames and drops
    // everything above the first one, so a poisoned header is never serialised
    // into the envelope. Verified by dumping the envelope under this mutation:
    // the address appears nowhere in it. Rebuilding the header defends the
    // in-memory Error object, which is crash.test.ts's job, not this one's.
    equivalent: 'the stack header is not serialised into the envelope',
    file: CRASH,
    find: `  const header = \`\${name}: \${safeMessage}\`;`,
    replace: `  const header = stack === undefined ? \`\${name}: \${safeMessage}\` : (stack.split('\\n')[0] ?? '');`
  },
  {
    name: 'beforeSend unwired AND the message scrubber neutered',
    guards: 'crash: no forbidden value',
    file: CRASH,
    find: `      beforeSend: scrubEvent`,
    replace: `      beforeSend: (event: unknown) => event`,
    also: {
      file: CRASH,
      find: `      const safeMessage = redactMessage(error.message, WORDLIST) ?? REDACTED;`,
      replace: `      const safeMessage = error.message;
      void redactMessage;
      void REDACTED;`
    }
  },
  {
    name: 'the consent gate removed from captureCrash',
    guards: 'nothing at all with consent off',
    file: CRASH,
    find: `      if (!(await isTelemetryEnabledAsync())) return;`,
    replace: `      await isTelemetryEnabledAsync();`
  },
  {
    name: 'crash reporting silenced entirely (anti-vacuity: no envelope is sent)',
    guards: 'crash: sends an envelope at all',
    file: CRASH,
    find: `      target.captureException(reportable);`,
    replace: `      void target;
      void reportable;`
  },
  {
    name: 'the address pattern removed from the redactor',
    guards: 'crash: no forbidden value',
    file: REDACT,
    find: `    .replace(ADDRESS_PATTERN, REDACTED)`,
    replace: ``
  },
  {
    name: 'the hex pattern removed from the redactor',
    guards: 'crash: no forbidden value',
    file: REDACT,
    find: `    .replace(HEX_PATTERN, REDACTED)`,
    replace: ``
  },
  {
    name: 'the digit-run pattern removed from the redactor',
    guards: 'crash: no forbidden value',
    file: REDACT,
    find: `    .replace(DIGITS_PATTERN, REDACTED);`,
    replace: `;`
  },
  {
    name: 'the assignment (password=…) pattern removed from the redactor',
    guards: 'crash: no named credential leaks',
    file: REDACT,
    find: `    .replace(ASSIGNMENT_PATTERN, \`$1\${REDACTED}\`)`,
    replace: ``
  },
  {
    name: 'the URL-credentials pattern removed from the redactor',
    guards: 'crash: no forbidden value',
    file: REDACT,
    find: `    .replace(URL_USERINFO_PATTERN, \`$1\${REDACTED}@\`)`,
    replace: ``
  },
  {
    name: 'the encoded-token decoder removed from the redactor',
    guards: 'crash: no forbidden value in an encoded form',
    file: REDACT,
    find: `  return redactEncodedTokens(applyPatterns(text), words);`,
    replace: `  return applyPatterns(text);`,
    also: {
      file: REDACT,
      find: `  const redacted = redactEncodedTokens(applyPatterns(message), words);`,
      replace: `  const redacted = applyPatterns(message);`
    }
  },
  {
    name: 'the seed-material check removed from the message scrubber',
    guards: 'crash: no recovery phrase',
    // `scrubEvent`, wired as beforeSend, still discards the whole event — the
    // deliberate second layer documented in crash.ts. The next mutation removes
    // both at once and IS caught, which is what proves the guard sees a phrase
    // rather than that some layer happened to hold.
    equivalent: 'beforeSend still discards the whole event',
    file: REDACT,
    find: `  if (decodedViews(message).some(view => viewHasSeedMaterial(view, words))) return null;`,
    replace: ``
  },
  {
    name: 'the seed-material check removed from the message scrubber AND beforeSend unwired',
    guards: 'crash: no recovery phrase',
    file: REDACT,
    find: `  if (decodedViews(message).some(view => viewHasSeedMaterial(view, words))) return null;`,
    replace: ``,
    also: {
      file: CRASH,
      find: `      beforeSend: scrubEvent`,
      replace: `      beforeSend: (event: unknown) => event`
    }
  },
  {
    name: 'the seed-material check removed from the text scrubber',
    guards: 'crash: no recovery phrase in a stack frame',
    file: REDACT,
    find: `  if (decodedViews(text).some(view => viewHasSeedMaterial(view, words))) return REDACTED;`,
    replace: ``
  },
  // --- the boundary being bypassed altogether ---
  {
    name: 'a second call site reaching the sender directly',
    guards: 'one consent-gated sender, reached from one place',
    file: 'src/lib/miden/back/main.ts',
    find: `import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';`,
    replace: `import { sendEvent } from 'lib/telemetry/sink';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';
void sendEvent;`
  },
  {
    name: 'the crash SDK imported outside the module that scrubs',
    guards: 'the crash SDK is confined to crash.ts',
    file: 'src/lib/miden/back/main.ts',
    find: `import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';`,
    replace: `import { captureException } from '@sentry/browser';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';
void captureException;`
  },
  {
    name: 'the recovery-phrase run threshold raised out of reach',
    guards: 'crash: no recovery phrase',
    file: REDACT,
    find: `export const BIP39_RUN_THRESHOLD = 4;`,
    replace: `export const BIP39_RUN_THRESHOLD = 400;`
  }
];

const GUARD_TEST = 'src/lib/telemetry/egress-boundary.test.ts';

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
    execFileSync('node', ['node_modules/.bin/jest', GUARD_TEST], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8'
    });
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
    broken++;
    console.log(`BROKEN  ${label}\n        ${error.message.split('\n')[0]}`);
    continue;
  } finally {
    restore(backups);
  }

  if (result.failed) {
    killed++;
    const names = failingTests(result.output);
    console.log(`KILLED  ${label}\n        guard: ${mutation.guards}\n        tripped: ${names.join('; ')}`);
  } else if (mutation.equivalent) {
    equivalent++;
    console.log(`NO EGRESS ${label}\n        nothing reaches the wire: ${mutation.equivalent}`);
  } else {
    survived++;
    console.log(`SURVIVED ${label}\n        guard that should have caught it: ${mutation.guards}`);
  }
}

console.log(
  `\n${killed} killed, ${equivalent} equivalent, ${survived} survived, ${broken} broken anchors, ${MUTATIONS.length} total`
);
process.exit(survived === 0 && broken === 0 ? 0 : 1);
