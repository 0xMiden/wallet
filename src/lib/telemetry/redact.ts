/**
 * Scrubbing for crash reports.
 *
 * A crash report is the one telemetry payload that cannot be built from a
 * closed allowlist the way `TelemetryWirePayload` is: an exception message, a
 * stack frame, and a breadcrumb are free text written by whoever threw. In this
 * codebase that plausibly includes an address, an amount, a note id, a
 * password, or — worst case — a word from a recovery phrase. So nothing free
 * text is ever sent verbatim.
 *
 * These are pure functions on purpose. Sentry's `beforeSend` is the hook that
 * actually applies them, but a hook is a wire that can come loose; the same
 * scrubbing has to be assertable without standing up a client.
 *
 * The old `censorKeys` in `src/shared/logger.ts` matched `APrivateKey` /
 * `AViewKey`, which are Aleo formats. Miden has none of those. The patterns
 * below are Miden's: bech32 account addresses (`mtst1…`, `mdev1…`, `mlcl1…`,
 * `mm1…`, optionally with the `_<routing suffix>` composite form), hex words
 * for note ids / commitments / serialized `AuthSecretKey`s, and digit runs for
 * amounts and balances.
 */

export const REDACTED = '[redacted]';

/**
 * How many consecutive BIP-39 words it takes to read a string as a recovery
 * phrase.
 *
 * One is far too low. The wordlist is 2048 ordinary English words — "about",
 * "action", "advice", "account", "amount", "note", "key" — and 63% of this
 * wallet's UI strings contain at least one, so a single-word rule would blind
 * the crash reporter rather than protect anything.
 *
 * Four is the balance point measured against the 937 real strings in
 * `public/_locales/en/en.json`: 98.2% of them peak at a run of three or fewer,
 * and the 1.8% that reach four are seed-phrase help copy that *should* be
 * dropped. Meanwhile the thing we are defending against is 12 or 24 words, so
 * a real phrase clears this bar by 3x and would have to be truncated to three
 * words — no longer a recoverable secret — to slip past.
 *
 * The cost of a false positive is only a lost free-text diagnostic; the error
 * class and the stack still go out. That asymmetry is why this errs low.
 */
export const BIP39_RUN_THRESHOLD = 4;

/**
 * Words that mean the surrounding text is *about* a recovery phrase. Paired
 * with a single wordlist hit these drop the message, which covers the realistic
 * one-word leak: a mnemonic validation error naming the word that failed
 * (`ImportSeedPhrase.tsx` checks input against the wordlist word by word).
 * They are excluded from counting as the hit themselves, so "seed phrase input
 * is empty" — which leaks nothing — survives.
 */
const MNEMONIC_CONTEXT_WORDS = new Set([
  'mnemonic',
  'seed',
  'seedphrase',
  'phrase',
  'recovery',
  'passphrase',
  'wordlist',
  'word',
  'words'
]);

const MNEMONIC_CONTEXT_PATTERN = /\b(?:mnemonic|seed|seedphrase|phrase|recovery|passphrase|wordlist|words?)\b/i;

/**
 * The value patterns are deliberately unanchored — no leading or trailing
 * `\b`. A word boundary looks tidy and is trivially evaded: `Error` + an
 * address concatenates into `Errormtst1aq…`, where there is no boundary
 * between `r` and `m` and the address sails through. Matching mid-token
 * over-redacts a little and cannot be sidestepped by gluing a secret onto a
 * word.
 */

/** Miden bech32 account addresses, bare or in the composite `<address>_<suffix>` form. */
const ADDRESS_PATTERN = /(?:mtst|mdev|mlcl|mm)1[0-9a-z]{6,}(?:_[0-9a-z]+)?/gi;
/** Hex words long enough to be a note id, a commitment, or a serialized key. */
const HEX_PATTERN = /(?:0x)?[0-9a-f]{16,}/gi;
/** Digit runs long enough to be an amount, a balance, or a base-unit quantity. */
const DIGITS_PATTERN = /\d{4,}/g;
/** `https://user:password@host` — the shape an RPC URL with credentials takes. */
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
/** Everything from the first `?` or `#` of a URL: query strings and fragments carry secrets, paths carry diagnosis. */
const URL_TAIL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]*?)[?#][^\s"'<>)\]}]*/gi;
/** `Bearer <token>` / `Basic <token>`, matched before the assignment rule so the scheme word is not mistaken for the value. */
const BEARER_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** `password=…`, `"secret": "…"`, `apiKey = …` — the key survives, the value does not. */
const ASSIGNMENT_PATTERN =
  /((?:pass(?:word|code|phrase)?|secret|seed|mnemonic|private[_-]?key|secret[_-]?key|api[_-]?key|token|auth(?:orization)?|credential|pin)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi;

/**
 * A run of characters that could be an encoded blob. Long enough that ordinary
 * words and identifiers do not qualify, so decoding is only attempted on things
 * that plausibly *are* encodings.
 */
const ENCODED_TOKEN_PATTERN = /[A-Za-z0-9%+/=._~:-]{16,}/g;

const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

/** Decode `%XX` escapes, or `null` when the text is not valid percent-encoding. */
function decodePercent(text: string): string | null {
  if (!text.includes('%')) return null;
  try {
    const decoded = decodeURIComponent(text);
    return decoded === text ? null : decoded;
  } catch {
    return null;
  }
}

/** Undo the JSON string escapes that would otherwise break a word run apart. */
function decodeJsonEscapes(text: string): string | null {
  if (!text.includes('\\')) return null;
  const decoded = text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["'\\/])/g, '$1');
  return decoded === text ? null : decoded;
}

/** Decode base64 or base64url, or `null` when the token is not printable text. */
function decodeBase64(token: string): string | null {
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  if (!BASE64_SHAPE.test(padded)) return null;
  let decoded: string;
  try {
    decoded = atob(padded);
  } /* c8 ignore next 3 -- BASE64_SHAPE already rejects everything atob throws on; kept in case an engine disagrees */ catch {
    return null;
  }
  if (decoded.length < 8 || !PRINTABLE_ASCII.test(decoded)) return null;
  return decoded === token ? null : decoded;
}

/**
 * The same text as an attacker could have encoded it. Detection runs against
 * every view, so base64'ing or URI-escaping a phrase does not smuggle it out.
 */
function decodedViews(text: string): string[] {
  const views = [text];
  for (const decode of [decodePercent, decodeJsonEscapes]) {
    const decoded = decode(text);
    if (decoded !== null) views.push(decoded);
  }
  for (const view of [...views]) {
    for (const token of view.match(ENCODED_TOKEN_PATTERN) ?? []) {
      const decoded = decodeBase64(token);
      if (decoded !== null) views.push(decoded);
    }
  }
  return views;
}

function viewHasSeedMaterial(view: string, words: ReadonlySet<string>): boolean {
  const tokens = tokenize(view);

  let run = 0;
  for (const token of tokens) {
    run = words.has(token) ? run + 1 : 0;
    if (run >= BIP39_RUN_THRESHOLD) return true;
  }

  if (!MNEMONIC_CONTEXT_PATTERN.test(view)) return false;
  return tokens.some(token => words.has(token) && !MNEMONIC_CONTEXT_WORDS.has(token));
}

/**
 * Whether the text reads as recovery-phrase material — either a run of
 * consecutive wordlist words, or a single one in a message that is explicitly
 * about mnemonics. Checked against every decoded view of the text.
 */
export function containsSeedMaterial(text: string, wordlist: readonly string[]): boolean {
  const words = new Set(wordlist.map(word => word.toLowerCase()));
  return decodedViews(text).some(view => viewHasSeedMaterial(view, words));
}

function applyPatterns(text: string): string {
  return text
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`)
    .replace(URL_TAIL_PATTERN, `$1${REDACTED}`)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(ADDRESS_PATTERN, REDACTED)
    .replace(HEX_PATTERN, REDACTED)
    .replace(DIGITS_PATTERN, REDACTED);
}

/**
 * Replace whole tokens whose *decoded* form is a secret. Patterns cannot see
 * through base64 or percent-encoding, so the token is judged by what it
 * decodes to and dropped as a unit.
 */
function redactEncodedTokens(text: string, words: ReadonlySet<string>): string {
  return text.replace(ENCODED_TOKEN_PATTERN, token => {
    const candidates = [decodePercent(token), decodeBase64(token)];
    for (const candidate of candidates) {
      if (candidate === null) continue;
      if (viewHasSeedMaterial(candidate, words) || applyPatterns(candidate) !== candidate) return REDACTED;
    }
    return token;
  });
}

/**
 * Scrub a string. Returns the marker for anything that reads as recovery-phrase
 * material and a pattern-scrubbed string otherwise. Never returns `null`: this
 * is for places like stack frames where there is no "drop it" option, only
 * "send it scrubbed".
 */
export function redactText(text: string, wordlist: readonly string[]): string {
  const words = new Set(wordlist.map(word => word.toLowerCase()));
  if (decodedViews(text).some(view => viewHasSeedMaterial(view, words))) return REDACTED;
  return redactEncodedTokens(applyPatterns(text), words);
}

/**
 * Scrub an exception message. `null` means "drop it entirely" — either it was
 * recovery-phrase material, or scrubbing left nothing but markers, at which
 * point the error class and the stack carry more signal than the remains.
 */
export function redactMessage(message: string, wordlist: readonly string[]): string | null {
  const words = new Set(wordlist.map(word => word.toLowerCase()));
  if (decodedViews(message).some(view => viewHasSeedMaterial(view, words))) return null;

  const redacted = redactEncodedTokens(applyPatterns(message), words);
  const withoutMarkers = redacted.split(REDACTED).join('').trim();
  return withoutMarkers.length === 0 ? null : redacted;
}

/**
 * Keys whose value is sensitive whatever it looks like. `password` is the
 * reason this exists: `hunter2` matches no pattern, so only the key betrays it.
 */
const SENSITIVE_KEY_PARTS = new Set([
  'account',
  'accounts',
  'address',
  'addresses',
  'amount',
  'amounts',
  'auth',
  'authorization',
  'balance',
  'balances',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'email',
  'entropy',
  'faucet',
  'header',
  'headers',
  'ip',
  'ipaddress',
  'key',
  'keys',
  'mnemonic',
  'noteid',
  'noteids',
  'nullifier',
  'pass',
  'passcode',
  'passphrase',
  'password',
  'phrase',
  'pin',
  'private',
  'privatekey',
  'query',
  'querystring',
  'recipient',
  'secret',
  'seed',
  'sender',
  'signature',
  'token',
  'user',
  'username'
]);

/**
 * Keys Sentry needs intact for the report to be routable and readable. They are
 * skipped rather than scrubbed because `event_id` is 32 hex characters and
 * would otherwise be eaten by the hex rule, taking the report's identity with
 * it. None of them can hold caller-supplied text.
 */
const STRUCTURAL_KEYS = new Set([
  'colno',
  'debug_meta',
  'environment',
  'event_id',
  'in_app',
  'level',
  'lineno',
  'logger',
  'mechanism',
  'modules',
  'platform',
  'release',
  'sdk',
  'timestamp'
]);

/** Split `noteId`, `note_id`, and `note-id` alike into their parts. */
function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(part => part.length > 0)
    .map(part => part.toLowerCase());
}

function isSensitiveKey(key: string): boolean {
  const parts = keyParts(key);
  return parts.some(part => SENSITIVE_KEY_PARTS.has(part)) || SENSITIVE_KEY_PARTS.has(parts.join(''));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function walk(value: unknown, words: readonly string[], seen: WeakSet<object>): void {
  if (isUnknownArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (typeof item === 'string') value[index] = redactText(item, words);
      else walk(item, words, seen);
    }
    return;
  }

  if (!isPlainRecord(value) || seen.has(value)) return;
  seen.add(value);

  for (const key of Object.keys(value)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    if (isSensitiveKey(key)) {
      value[key] = REDACTED;
      continue;
    }
    const child = value[key];
    if (typeof child === 'string') value[key] = redactText(child, words);
    else walk(child, words, seen);
  }
}

/**
 * Scrub every string reachable in a structure, in place.
 *
 * In place, and not a rebuild, because the caller hands us a Sentry `Event`:
 * mutating string leaves preserves the object's shape and its type, where
 * reconstructing it would need a cast. Cycles are tracked, since a captured
 * error can hold a reference back to an object that holds it.
 */
export function redactInPlace(value: unknown, wordlist: readonly string[]): void {
  walk(value, wordlist, new WeakSet());
}

/**
 * Whether any string anywhere in the structure reads as recovery-phrase
 * material. A seed phrase in a crash report means the payload is contaminated
 * and the whole report is worth less than the risk of sending it.
 */
export function containsSeedMaterialDeep(value: unknown, wordlist: readonly string[]): boolean {
  return anySeedMaterial(value, wordlist, new WeakSet());
}

function anySeedMaterial(value: unknown, wordlist: readonly string[], seen: WeakSet<object>): boolean {
  if (typeof value === 'string') return containsSeedMaterial(value, wordlist);

  if (isUnknownArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some(item => anySeedMaterial(item, wordlist, seen));
  }

  if (!isPlainRecord(value) || seen.has(value)) return false;
  seen.add(value);

  return Object.keys(value).some(key => !STRUCTURAL_KEYS.has(key) && anySeedMaterial(value[key], wordlist, seen));
}
