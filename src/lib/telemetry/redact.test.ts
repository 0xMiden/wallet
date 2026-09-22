import bip39English from 'bip39/src/wordlists/english.json';

import {
  BIP39_RUN_THRESHOLD,
  REDACTED,
  containsSeedMaterial,
  containsSeedMaterialDeep,
  redactInPlace,
  redactMessage,
  redactText
} from './redact';

/** The three-word list the brief's examples use — keeps those cases readable. */
const wordlist = ['abandon', 'ability', 'zoo'];

/** The real 2048-word list, for everything that has to behave like production. */
const english: readonly string[] = bip39English;

/**
 * Valid BIP-39 mnemonics generated from the bundled wordlist. They are real in
 * every respect that matters to the redactor (real words, real checksum) and
 * guard no real funds.
 */
const PHRASE_12 = 'avoid leave side crush call gasp confirm deal student link chunk interest';
const PHRASE_24 =
  'echo cross route trophy art call defy cat swift tail moral right follow mansion arm intact pulp frame truck connect cotton throw release play';

const PRIVATE_KEY_HEX = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const SECRET_KEY_HEX = 'a3bf4f1b2b0b822cd15d6c15b0f00a089f86d081884c7d659a2feaa0c55ad015';
const ADDRESS = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
const COMPOSITE_ADDRESS = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe_qr7qqq9wr6w';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const b64url = (value: string) => b64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('redactMessage — the brief\u2019s baseline', () => {
  it('drops a mnemonic-validation message naming a single seed word', () => {
    expect(redactMessage('invalid mnemonic word: abandon', wordlist)).toBeNull();
  });

  it('drops on a wordlist match regardless of case', () => {
    expect(redactMessage('Bad word ABILITY at index 3', wordlist)).toBeNull();
  });

  it('matches only whole words', () => {
    expect(redactMessage('abandonment of the request', wordlist)).not.toBeNull();
  });

  it('redacts a Miden bech32 address', () => {
    const out = redactMessage('cannot reach mtst1qqqqqqabcdefghij', wordlist);
    expect(out).not.toContain('mtst1qqqqqqabcdefghij');
    expect(out).toContain(REDACTED);
  });

  it('redacts a long hex run', () => {
    const out = redactMessage('note 0x4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c failed', wordlist);
    expect(out).not.toContain('4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c');
    expect(out).toContain('note');
  });

  it('redacts digit sequences that could be amounts', () => {
    const out = redactMessage('insufficient balance 4200000000', wordlist);
    expect(out).not.toContain('4200000000');
  });

  it('leaves an innocuous message intact', () => {
    expect(redactMessage('rpc endpoint returned status', wordlist)).toBe('rpc endpoint returned status');
  });

  it('drops a message that is entirely redacted away', () => {
    expect(redactMessage('mtst1qqqqqqabcdefghij', wordlist)).toBeNull();
  });
});

describe('seed-phrase detection', () => {
  it('requires a run rather than a single ordinary English word', () => {
    // "about", "action" and "advice" are BIP-39 words *and* ordinary English.
    // One of them in a sentence must not cost us the whole message.
    expect(containsSeedMaterial('the action failed', english)).toBe(false);
    expect(redactMessage('the action failed', english)).toBe('the action failed');
  });

  it('normalizes the wordlist it is handed, rather than assuming lowercase', () => {
    expect(containsSeedMaterial('abandon ability able about', ['ABANDON', 'ABILITY', 'ABLE', 'ABOUT'])).toBe(true);
  });

  it('detects a 12-word phrase', () => {
    expect(containsSeedMaterial(PHRASE_12, english)).toBe(true);
    expect(redactMessage(PHRASE_12, english)).toBeNull();
  });

  it('detects a 24-word phrase', () => {
    expect(containsSeedMaterial(PHRASE_24, english)).toBe(true);
    expect(redactMessage(PHRASE_24, english)).toBeNull();
  });

  it('detects a phrase buried inside an otherwise ordinary sentence', () => {
    expect(redactMessage(`could not import wallet from "${PHRASE_12}" at step 2`, english)).toBeNull();
  });

  it('detects a phrase whose words are comma-separated', () => {
    expect(containsSeedMaterial(PHRASE_12.split(' ').join(', '), english)).toBe(true);
  });

  it('detects a phrase broken across newlines and mixed case', () => {
    const smuggled = PHRASE_12.split(' ')
      .map((word, index) => (index % 2 === 0 ? word.toUpperCase() : word))
      .join('\n');
    expect(containsSeedMaterial(smuggled, english)).toBe(true);
  });

  it('detects a phrase padded with irregular whitespace', () => {
    expect(containsSeedMaterial(PHRASE_12.split(' ').join('   \t '), english)).toBe(true);
  });

  it('pins the threshold at four literal words, independently of the constant', () => {
    // Spelled out rather than sliced from the wordlist: a test that derives its
    // fixture from BIP39_RUN_THRESHOLD moves with the constant and would pass
    // at any value.
    expect(containsSeedMaterial('abandon ability able', english)).toBe(false);
    expect(containsSeedMaterial('abandon ability able about', english)).toBe(true);
    expect(BIP39_RUN_THRESHOLD).toBe(4);
  });

  it(`triggers at exactly ${BIP39_RUN_THRESHOLD} consecutive words and not at one fewer`, () => {
    const run = english.slice(0, BIP39_RUN_THRESHOLD).join(' ');
    const shortRun = english.slice(0, BIP39_RUN_THRESHOLD - 1).join(' ');
    expect(containsSeedMaterial(run, english)).toBe(true);
    // A non-wordlist token must break the run, or the threshold means nothing.
    expect(containsSeedMaterial(shortRun, english)).toBe(false);
    expect(containsSeedMaterial(`${shortRun} qqqq ${shortRun}`, english)).toBe(false);
  });

  it('drops a single seed word when the message is about mnemonics', () => {
    // The realistic single-word leak: a validation error naming the bad word.
    expect(containsSeedMaterial('seed phrase rejected: abandon', english)).toBe(true);
    expect(containsSeedMaterial('recovery phrase word 4 is invalid: zoo', english)).toBe(true);
  });

  it('does not treat mnemonic vocabulary alone as a leak', () => {
    // "phrase" and "word" are themselves wordlist entries. If they counted as
    // the hit, every mnemonic-related diagnostic would drop and the rule would
    // be indistinguishable from "never report anything about seed phrases".
    expect(containsSeedMaterial('recovery phrase checksum mismatch', english)).toBe(false);
    expect(containsSeedMaterial('mnemonic validation failed', english)).toBe(false);
  });

  it('errs toward dropping when a mnemonic message names any other wordlist word', () => {
    // "input" and "empty" are ordinary English *and* BIP-39 words, so this is a
    // false positive — and the right one. We lose a diagnostic, not a secret.
    expect(containsSeedMaterial('seed phrase input is empty', english)).toBe(true);
  });

  it('keeps ordinary wallet diagnostics intact', () => {
    const survivors = [
      'rpc endpoint returned status',
      'Transaction proving timed out',
      'Cannot read properties of undefined',
      'Guardian approval was denied by the remote signer',
      'failed to load wasm module',
      'unexpected end of JSON input',
      'quota exceeded while writing to indexeddb'
    ];
    for (const survivor of survivors) {
      expect(containsSeedMaterial(survivor, english)).toBe(false);
      expect(redactMessage(survivor, english)).toBe(survivor);
    }
  });
});

describe('secret patterns', () => {
  it('redacts a private key with and without the 0x prefix', () => {
    expect(redactText(`key ${PRIVATE_KEY_HEX}`, english)).not.toContain('9f86d081');
    expect(redactText(`key ${SECRET_KEY_HEX}`, english)).not.toContain('a3bf4f1b');
  });

  it('redacts an uppercase hex key', () => {
    expect(redactText(`KEY ${SECRET_KEY_HEX.toUpperCase()}`, english)).not.toContain('A3BF4F1B');
  });

  it('redacts a password in an error message', () => {
    const out = redactText('login failed for password=hunter2correcthorse', english);
    expect(out).not.toContain('hunter2correcthorse');
    expect(out).toContain('password');
  });

  it('redacts a quoted password in a JSON-ish message', () => {
    expect(redactText('{"password": "hunter2correcthorse"}', english)).not.toContain('hunter2correcthorse');
    expect(redactText("{'passcode': 'abcdefgh'}", english)).not.toContain('abcdefgh');
  });

  it('redacts passcode, pin, token and api key assignments', () => {
    expect(redactText('passcode=998877', english)).not.toContain('998877');
    expect(redactText('pin: 4821', english)).not.toContain('4821');
    expect(redactText('token=eyJhbGciOiJIUzI1NiJ9', english)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redactText('apiKey = sk_live_abcdef123456', english)).not.toContain('sk_live_abcdef123456');
  });

  it('redacts a bearer credential', () => {
    expect(redactText('authorization: Bearer abcdef.ghijkl.mnopqr', english)).not.toContain('abcdef.ghijkl.mnopqr');
  });

  it('redacts every Miden network address prefix', () => {
    for (const address of ['mtst1aqsjql4cyylvpu', 'mdev1aqsjql4cyylvpu', 'mlcl1aqsjql4cyylvpu', 'mm1aqsjql4cyylvpu']) {
      expect(redactText(`send to ${address}`, english)).not.toContain(address);
    }
  });

  it('redacts the composite `<address>_<suffix>` account form', () => {
    expect(redactText(`sender ${COMPOSITE_ADDRESS}`, english)).not.toContain('qr7qqq9wr6w');
  });

  it('redacts an uppercase bech32 address', () => {
    expect(redactText(`send to ${ADDRESS.toUpperCase()}`, english)).not.toContain(ADDRESS.toUpperCase());
  });

  it('redacts amounts and balances', () => {
    expect(redactText('insufficient balance 4200000000 for fee 12345', english)).not.toMatch(/\d{4}/);
  });

  it('redacts credentials embedded in an RPC URL', () => {
    const out = redactText('connect https://alice:s3cr3tpass@rpc.testnet.miden.io/v1', english);
    expect(out).not.toContain('s3cr3tpass');
    expect(out).not.toContain('alice');
    // The host is the diagnostic value we are keeping.
    expect(out).toContain('rpc.testnet.miden.io');
  });

  it('redacts a secret carried in a URL query string', () => {
    const out = redactText(`GET https://rpc.testnet.miden.io/v1/notes?account=${ADDRESS}&apiKey=sk_live_9988`, english);
    expect(out).not.toContain(ADDRESS);
    expect(out).not.toContain('sk_live_9988');
    expect(out).toContain('rpc.testnet.miden.io');
  });

  it('redacts a query string whose value no other rule would catch', () => {
    // `q=alicewallet` is not hex, not a digit run, not an address, and `q` is
    // not a sensitive key name. Only stripping the query string removes it.
    const out = redactText('GET https://rpc.testnet.miden.io/v1/notes?q=alicewallet', english);
    expect(out).not.toContain('alicewallet');
    expect(out).toContain('rpc.testnet.miden.io');
  });

  it('redacts a fragment whose value no other rule would catch', () => {
    const out = redactText('opened https://example.com/page#ref=alicewallet', english);
    expect(out).not.toContain('alicewallet');
    expect(out).toContain('example.com');
  });

  it('redacts a secret carried in a URL fragment', () => {
    expect(redactText(`https://example.com/page#seed=${PHRASE_12.split(' ')[0]}`, english)).not.toContain('#seed=');
  });

  it('keeps a bundle filename in a stack frame readable', () => {
    // Over-redacting a stack costs us the entire point of a crash report.
    const frame = 'at handleSend (chrome-extension://abcdefgh/assets/index-a1b2c3d4.js:12:34)';
    const out = redactText(frame, english);
    expect(out).toContain('handleSend');
    expect(out).toContain('index-a1b2c3d4.js');
  });

  it('redacts an address smuggled into a stack frame path', () => {
    const frame = `at send (chrome-extension://abcdefgh/accounts/${ADDRESS}/index.js:12:34)`;
    const out = redactText(frame, english);
    expect(out).not.toContain(ADDRESS);
    expect(out).toContain('send');
  });

  it('catches a secret glued onto a preceding word', () => {
    // A word boundary before the pattern is trivially evaded by concatenation:
    // `Error` + an address leaves no boundary between `r` and `m`.
    expect(redactText(`Error${COMPOSITE_ADDRESS}`, english)).not.toContain('qr7qqq9wr6w');
    expect(redactText(`key${SECRET_KEY_HEX}`, english)).not.toContain('a3bf4f1b');
    expect(redactText('balance4200000000', english)).not.toContain('4200000000');
  });

  it('catches a secret glued onto a following word', () => {
    expect(redactText(`${SECRET_KEY_HEX}please`, english)).not.toContain('a3bf4f1b');
    expect(redactText('4200000000zed', english)).not.toContain('4200000000');
  });

  it('never returns the marker for a clean string', () => {
    expect(redactText('sync finished', english)).toBe('sync finished');
  });
});

describe('encoding variants', () => {
  it('redacts a base64-encoded mnemonic', () => {
    const encoded = b64(PHRASE_12);
    expect(encoded.length).toBeGreaterThan(0);
    expect(redactText(`payload ${encoded}`, english)).not.toContain(encoded);
  });

  it('drops a message carrying a base64-encoded mnemonic', () => {
    expect(redactMessage(`restore failed: ${b64(PHRASE_24)}`, english)).toBeNull();
  });

  it('redacts a base64url-encoded mnemonic that uses the url-safe alphabet', () => {
    // Standard base64 of plain lowercase text happens never to contain `+` or
    // `/`, so a fixture without them would pass even if base64url normalization
    // were removed. The prefix forces the url-safe alphabet into play.
    const encoded = b64url(`~~~ ${PHRASE_12}`);
    expect(encoded).toMatch(/[-_]/);
    expect(redactText(`payload ${encoded}`, english)).not.toContain(encoded);
  });

  it('redacts a base64-encoded private key', () => {
    const encoded = b64(PRIVATE_KEY_HEX);
    expect(redactText(`body ${encoded}`, english)).not.toContain(encoded);
  });

  it('redacts a base64-encoded address', () => {
    const encoded = b64(COMPOSITE_ADDRESS);
    expect(redactText(`body ${encoded}`, english)).not.toContain(encoded);
  });

  it('redacts a URI-encoded mnemonic', () => {
    const encoded = encodeURIComponent(PHRASE_12);
    expect(encoded).toContain('%20');
    expect(redactMessage(`query ${encoded}`, english)).toBeNull();
  });

  it('redacts a mnemonic whose every character is percent-encoded', () => {
    // `encodeURIComponent` leaves letters alone, so the words survive as plain
    // text and the run detector sees them anyway. Encoding every character
    // leaves no letters at all — only percent-decoding recovers the phrase.
    const encoded = [...PHRASE_12].map(char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
    expect(encoded).not.toMatch(/[a-z]{3,}/);
    expect(redactMessage(`payload ${encoded}`, english)).toBeNull();
  });

  it('redacts a URI-encoded address', () => {
    const encoded = encodeURIComponent(`miden:${COMPOSITE_ADDRESS}`);
    expect(redactText(`scan ${encoded}`, english)).not.toContain('qr7qqq9wr6w');
  });

  it('redacts a mnemonic hidden behind JSON escapes', () => {
    const escaped = PHRASE_12.split(' ').join('\\n');
    expect(escaped).toContain('\\n');
    expect(redactMessage(`parse error near ${escaped}`, english)).toBeNull();
  });

  it('redacts a mnemonic hidden behind unicode escapes', () => {
    const escaped = PHRASE_12.replace(/^./, char => `\\u00${char.charCodeAt(0).toString(16)}`);
    expect(escaped).toContain('\\u00');
    expect(redactMessage(escaped, english)).toBeNull();
  });

  it('redacts a JSON-stringified secret payload', () => {
    const payload = JSON.stringify({ mnemonic: PHRASE_12, address: COMPOSITE_ADDRESS });
    const out = redactText(`request body ${payload}`, english);
    expect(out).not.toContain('avoid leave side');
    expect(out).not.toContain('qr7qqq9wr6w');
  });

  it('tolerates a backslash that is not an escape sequence', () => {
    expect(redactText('path a\\b c', english)).toBe('path a\\b c');
  });

  it('handles text with no letters at all', () => {
    expect(containsSeedMaterial('1234 5678', english)).toBe(false);
  });

  it('tolerates a stray percent sign that is not an escape sequence', () => {
    expect(redactText('progress 100% complete', english)).toBe('progress 100% complete');
    expect(redactMessage('sync 50%z done', english)).toBe('sync 50%z done');
  });

  it('does not mistake ordinary prose for an encoded secret', () => {
    const prose = 'the request completed successfully';
    expect(redactText(prose, english)).toBe(prose);
  });
});

describe('redactInPlace', () => {
  it('redacts strings nested deep in extra', () => {
    const event = { extra: { request: { body: { seedPhrase: PHRASE_12 } } } };
    redactInPlace(event, english);
    expect(JSON.stringify(event)).not.toContain('avoid');
  });

  it('redacts strings nested deep in contexts', () => {
    const event = { contexts: { wallet: { activeAccount: COMPOSITE_ADDRESS, balance: '4200000000' } } };
    redactInPlace(event, english);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('qr7qqq9wr6w');
    expect(serialized).not.toContain('4200000000');
  });

  it('redacts breadcrumb messages and breadcrumb request data', () => {
    const event = {
      breadcrumbs: [
        { message: `navigated to ${ADDRESS}`, data: { url: `https://rpc.io/v1?apiKey=sk_live_998877` } },
        { message: 'clicked send' }
      ]
    };
    redactInPlace(event, english);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(ADDRESS);
    expect(serialized).not.toContain('sk_live_998877');
    // Positive control: the harmless breadcrumb is still there.
    expect(serialized).toContain('clicked send');
  });

  it('redacts values under sensitive keys whatever their shape', () => {
    const event = { extra: { password: 'hunter2', balance: 4200000000, noteIds: [SECRET_KEY_HEX, 'plain'] } };
    redactInPlace(event, english);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('4200000000');
    expect(serialized).not.toContain('a3bf4f1b');
  });

  it('redacts every element of an array of secrets', () => {
    const event = { extra: { list: [ADDRESS, PRIVATE_KEY_HEX, 'ok'] } };
    redactInPlace(event, english);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(ADDRESS);
    expect(serialized).not.toContain('9f86d081');
    expect(serialized).toContain('ok');
  });

  it('preserves the event id and the error class', () => {
    const event = {
      event_id: '0123456789abcdef0123456789abcdef',
      exception: { values: [{ type: 'MidenAddressError', value: 'sync failed' }] }
    };
    redactInPlace(event, english);
    expect(event.event_id).toBe('0123456789abcdef0123456789abcdef');
    expect(event.exception.values[0]?.type).toBe('MidenAddressError');
    expect(event.exception.values[0]?.value).toBe('sync failed');
  });

  it('walks the whole exception chain, not just the first value', () => {
    const event = {
      exception: {
        values: [
          { type: 'Error', value: 'outer failed' },
          { type: 'Error', value: `inner: ${PHRASE_12}` }
        ]
      }
    };
    redactInPlace(event, english);
    expect(JSON.stringify(event)).not.toContain('avoid leave');
  });

  it('redacts secrets in stack frame paths and locals', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: `chrome-extension://abc/${ADDRESS}/index.js`, function: 'send', lineno: 12 },
                { filename: 'index.js', function: 'run', vars: { password: 'hunter2' } }
              ]
            }
          }
        ]
      }
    };
    redactInPlace(event, english);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(ADDRESS);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('send');
  });

  it('survives a circular structure', () => {
    const inner: Record<string, unknown> = { note: ADDRESS };
    inner.self = inner;
    const event = { extra: inner };
    expect(() => redactInPlace(event, english)).not.toThrow();
    expect(inner.note).not.toBe(ADDRESS);
  });

  it('survives an array that contains itself and is reachable twice', () => {
    const shared: unknown[] = [ADDRESS];
    shared.push(shared);
    const event = { extra: { first: shared, second: shared } };
    expect(() => redactInPlace(event, english)).not.toThrow();
    expect(shared[0]).not.toBe(ADDRESS);
  });

  it('ignores non-object input', () => {
    expect(() => redactInPlace(null, english)).not.toThrow();
    expect(() => redactInPlace('a string', english)).not.toThrow();
    expect(() => redactInPlace(undefined, english)).not.toThrow();
  });
});

describe('containsSeedMaterialDeep', () => {
  it('finds a phrase nested in extra', () => {
    expect(containsSeedMaterialDeep({ extra: { a: { b: PHRASE_12 } } }, english)).toBe(true);
  });

  it('finds a phrase in an array element', () => {
    expect(containsSeedMaterialDeep({ breadcrumbs: [{ message: 'ok' }, { message: PHRASE_24 }] }, english)).toBe(true);
  });

  it('finds a base64-encoded phrase nested in contexts', () => {
    expect(containsSeedMaterialDeep({ contexts: { c: { blob: b64(PHRASE_12) } } }, english)).toBe(true);
  });

  it('finds a phrase in a wrapped-error chain', () => {
    const event = {
      exception: { values: [{ value: 'import failed' }, { value: `caused by: ${PHRASE_12}` }] }
    };
    expect(containsSeedMaterialDeep(event, english)).toBe(true);
  });

  it('reports false for an ordinary event', () => {
    const event = {
      event_id: '0123456789abcdef0123456789abcdef',
      exception: { values: [{ type: 'Error', value: 'rpc endpoint returned status' }] },
      extra: { attempt: 3 }
    };
    expect(containsSeedMaterialDeep(event, english)).toBe(false);
  });

  it('does not trip on the structural keys it must leave alone', () => {
    expect(containsSeedMaterialDeep({ event_id: 'abandon ability able about' }, english)).toBe(false);
  });

  it('survives a circular structure', () => {
    const inner: Record<string, unknown> = { note: 'ok' };
    inner.self = inner;
    inner.list = [inner];
    expect(containsSeedMaterialDeep({ extra: inner }, english)).toBe(false);
  });

  it('survives an array that contains itself and is reachable twice', () => {
    const shared: unknown[] = ['ok'];
    shared.push(shared);
    expect(containsSeedMaterialDeep({ extra: { first: shared, second: shared } }, english)).toBe(false);
  });

  it('ignores non-object input', () => {
    expect(containsSeedMaterialDeep(null, english)).toBe(false);
    expect(containsSeedMaterialDeep(42, english)).toBe(false);
    expect(containsSeedMaterialDeep(PHRASE_12, english)).toBe(true);
  });
});
