import fs from 'fs';
import path from 'path';

// The swap receipt is rendered through react-i18next (src/i18n.ts), which reads
// the flat `<locale>/<locale>.json` bundles and interpolates NAMED `$name$`
// placeholders. So a `t(key, opts)` call whose option names drift from the
// placeholders in en.json does not fall back to anything sensible: the literal
// `$filled$ of $total$$symbol$ filled` reaches the user. Nothing in the
// component tests can see that, because they stub `t` and join option VALUES
// positionally — the names are invisible there. These guards read the real copy.
//
// The order-status labels are additionally pinned in `messages.json` (the
// extension-side `lib/i18n` catalogue). Machine translation rendered every one
// of them in the wrong sense — "Open" as the imperative verb (de "Öffnen",
// ja "開く"), "Filled" as filling a container (es "Relleno", zh_CN "已填入") —
// which for an order book means the opposite of the intended state. A bulk
// regeneration would silently reintroduce exactly those strings.

const LOCALES_DIR = path.join(__dirname, '../../../public/_locales');
const SRC_DIR = path.join(__dirname, '../../app/templates/history');

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8'));

const enJson = readJson(path.join(LOCALES_DIR, 'en/en.json')) as Record<string, string>;

const placeholdersOf = (message: string): string[] => [...message.matchAll(/\$([a-zA-Z0-9_]+)\$/g)].map(m => m[1]!);

/**
 * Collect `t('key', { ... })` call sites with their option names. Brace-matched
 * rather than regexed so a nested object or a ternary in a value cannot
 * truncate the option list and hide a mismatch.
 */
const translationCalls = (source: string): { key: string; options: string[] }[] => {
  const calls: { key: string; options: string[] }[] = [];
  const callStart = /\bt\('([a-zA-Z0-9_]+)'/g;

  for (let match = callStart.exec(source); match !== null; match = callStart.exec(source)) {
    const key = match[1]!;
    let cursor = match.index + match[0].length;
    while (source[cursor] === ' ' || source[cursor] === '\n') cursor++;
    if (source[cursor] !== ',') {
      calls.push({ key, options: [] });
      continue;
    }

    const open = source.indexOf('{', cursor);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }

    const body = source.slice(open + 1, end);
    // Top-level `name:` / shorthand `name` entries only; skip anything nested.
    const options: string[] = [];
    let nesting = 0;
    for (const part of body.split(',')) {
      const before = nesting;
      nesting += (part.match(/[{([]/g)?.length ?? 0) - (part.match(/[})\]]/g)?.length ?? 0);
      if (before !== 0) continue;
      const name = part.trim().match(/^([a-zA-Z0-9_]+)\s*(:|$)/);
      if (name) options.push(name[1]!);
    }
    calls.push({ key, options });
  }

  return calls;
};

const swapCalls = ['SwapDetail.tsx', 'HistoryDetails.tsx']
  .flatMap(file => translationCalls(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')))
  .filter(call => call.key in enJson || call.key.startsWith('swap') || call.key.startsWith('orderStatus'));

describe('swap receipt copy (#736)', () => {
  it('has an English string for every key the swap receipt asks for', () => {
    const missing = swapCalls.filter(call => typeof enJson[call.key] !== 'string').map(call => call.key);
    expect(missing).toEqual([]);
  });

  it('passes exactly the interpolation names the English copy declares', () => {
    const mismatched = swapCalls
      .filter(call => typeof enJson[call.key] === 'string')
      .map(call => ({
        key: call.key,
        passed: [...call.options].sort(),
        declared: [...new Set(placeholdersOf(enJson[call.key]!))].sort()
      }))
      .filter(entry => entry.passed.join() !== entry.declared.join());

    expect(mismatched).toEqual([]);
  });

  it('keeps the percent sign that makes the progress label a percentage', () => {
    // Sibling keys (`priceChangePercent`, `tokenDetailChange24h`) lost their `%`
    // in translation, leaving a bare number. Pin this one everywhere it exists.
    for (const locale of fs.readdirSync(LOCALES_DIR)) {
      const messages = readJson(path.join(LOCALES_DIR, locale, 'messages.json')) as Record<string, { message: string }>;
      const entry = messages['swapProgressPercent'];
      if (!entry) continue;
      expect(entry.message).toContain('$percentage$');
      expect(entry.message).toContain('%');
    }
  });

  describe('order-status labels state an order state, not a verb', () => {
    // Every value here is a real machine translation this PR had to correct.
    const rejected: Record<string, Partial<Record<string, string>>> = {
      de: { orderStatusActive: 'Öffnen', orderStatusFilled: 'Gefüllt', orderStatusReclaimed: 'Wiedergewonnen' },
      es: { orderStatusActive: 'Abrir', orderStatusFilled: 'Relleno' },
      fr: { orderStatusActive: 'Ouvrir', orderStatusFilled: 'Rempli' },
      ja: { orderStatusActive: '開く', orderStatusFilled: '埋まった', orderStatusReclaimed: '再生された' },
      ko: { orderStatusActive: '열기', orderStatusFilled: '채워짐' },
      pl: { orderStatusActive: 'Otwórz', orderStatusFilled: 'Wypełnione' },
      pt: { orderStatusActive: 'Abrir', orderStatusFilled: 'Preenchido' },
      ru: { orderStatusActive: 'Открыть', orderStatusFilled: 'Заполнен', orderStatusReclaimed: 'Восстановленный' },
      tr: { orderStatusActive: 'Aç', orderStatusFilled: 'Doldurulmuş' },
      uk: { orderStatusActive: 'Відкрити', orderStatusFilled: 'Заповнено', orderStatusReclaimed: 'Відновлений' },
      zh_CN: { orderStatusActive: '打开', orderStatusFilled: '已填入' },
      zh_TW: { orderStatusActive: '開啟', orderStatusFilled: '已填滿' }
    };

    for (const [locale, wrong] of Object.entries(rejected)) {
      it(`${locale} keeps the corrected order-state wording`, () => {
        const messages = readJson(path.join(LOCALES_DIR, locale, 'messages.json')) as Record<
          string,
          { message: string }
        >;
        for (const [key, rejectedMessage] of Object.entries(wrong)) {
          expect(messages[key]?.message).not.toBe(rejectedMessage);
        }
      });
    }
  });

  it('keeps the two English catalogues in agreement for the swap keys', () => {
    const messages = readJson(path.join(LOCALES_DIR, 'en/messages.json')) as Record<string, { message: string }>;
    const drifted = Object.keys(enJson)
      .filter(key => key.startsWith('swap') || key.startsWith('orderStatus') || key.startsWith('consumeTxId'))
      .filter(key => messages[key] && messages[key]!.message !== enJson[key])
      .map(key => ({ key, flat: enJson[key], messages: messages[key]!.message }));

    expect(drifted).toEqual([]);
  });
});
