/**
 * Every English string that names the network says "Miden $network$" (#875): the placeholder completes the
 * proper noun. Machine translation has split the pair before, parking the placeholder after the finished
 * sentence ("... 이용 중이십니다. $network$") or gluing it to the next word, so every locale keeps
 * "Miden $network$" together wherever English has it, and the DeepL job protects the pair as one span so a
 * re-translation cannot split it again.
 */

import fs from 'fs';
import path from 'path';

// generateLanguageFiles.ts is a CommonJS script (module.exports), so it has no ES exports to import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toDeepLXml } = require('../../../utility/generateLanguageFiles');

const NAME = 'Miden $network$';
const LOCALES_DIR = path.resolve(__dirname, '../../../public/_locales');
const read = (locale: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, `${locale}.json`), 'utf8'));

const english = read('en');
const keys = Object.entries(english)
  .filter(([, value]) => value.includes(NAME))
  .map(([key]) => key);
const locales = fs
  .readdirSync(LOCALES_DIR)
  .filter(locale => locale !== 'en' && fs.existsSync(path.join(LOCALES_DIR, locale, `${locale}.json`)));

describe('network name copy', () => {
  it('finds the English strings and every locale', () => {
    expect(keys).toEqual(expect.arrayContaining(['networkModeBanner', 'receiveTestFundsBody', 'shareAddressText']));
    expect(locales.length).toBeGreaterThan(10);
  });

  it.each(locales.flatMap(locale => keys.map(key => [locale, key])))(
    'keeps "Miden $network$" together in %s %s',
    (locale, key) => {
      expect(read(locale)[key]).toContain(NAME);
    }
  );

  it.each(keys)('protects "Miden $network$" as one DeepL span in %s', key => {
    expect(toDeepLXml(english[key])).toContain(`<x>${NAME}</x>`);
  });
});

// #875's titles, labels and CTAs end without punctuation in English. Machine translation has added a full
// stop to some ("Lo entiendo."), which reads as a sentence on a button or heading.
const UNPUNCTUATED_KEYS = [
  'devnet',
  'localnet',
  'networkModeBanner',
  'networkNoticeChip',
  'networkNoticeNoValueTitle',
  'networkNoticeNoRealFundsTitle',
  'networkNoticeResetTitle',
  'iUnderstand',
  'receiveTestFundsTitle',
  'crossChainFromNetwork',
  'ethereumSepolia',
  'bridgeTestFundsTitle',
  'shareAddressText',
  'qrNetworkCaption',
  'evmConnectTestWalletTitle'
];
const FULL_STOP = /[.。．]$/;

describe('test-network title and label punctuation', () => {
  it('lists English strings that exist and end without a full stop', () => {
    expect(UNPUNCTUATED_KEYS.filter(key => FULL_STOP.test(english[key] ?? '.'))).toEqual([]);
  });

  it.each(locales.flatMap(locale => UNPUNCTUATED_KEYS.map(key => [locale, key])))(
    'adds no full stop the English lacks (%s %s)',
    (locale, key) => {
      expect(read(locale)[key] ?? '').not.toMatch(FULL_STOP);
    }
  );
});
