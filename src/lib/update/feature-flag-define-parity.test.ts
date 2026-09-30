import { defineEntry, defineSource, occurrences, readSource, viteConfigs } from '../testing/define-parity';

const CONFIGS = viteConfigs();

const EXPECTED_DEFAULTS: Record<string, string> = {
  'vite.extension.config.ts': "(TARGET_BROWSER === 'chrome' ? 'true' : 'false')",
  'vite.background.config.ts': "(TARGET_BROWSER === 'chrome' ? 'true' : 'false')",
  'vite.contentScripts.config.ts': "'false'",
  'vite.mobile.config.ts': "'true'",
  'vite.desktop.config.ts': "'false'"
};

describe('update notification build-time flag', () => {
  it('gives every discovered build config an expected default', () => {
    // A new or renamed config fails here until it is given one, instead of going unchecked.
    expect(Object.keys(EXPECTED_DEFAULTS).sort()).toEqual(CONFIGS);
  });

  it.each(Object.entries(EXPECTED_DEFAULTS))('%s defines the supported-platform default', (config, defaultValue) => {
    const defines = defineSource(readSource(config));
    expect(occurrences(defines, `'process.env.MIDEN_UPDATE_NOTIFICATIONS':`)).toBe(1);
    expect(defines).toMatch(
      defineEntry('MIDEN_UPDATE_NOTIFICATIONS', `process.env.MIDEN_UPDATE_NOTIFICATIONS ?? ${defaultValue}`)
    );
  });

  it('declares the flag in ProcessEnv', () => {
    expect(readSource('src/react-app.d.ts')).toContain('readonly MIDEN_UPDATE_NOTIFICATIONS?: string;');
  });

  // Every bundle in which createDefaultAdapter can build the E2E adapter, plus
  // the rest for completeness: an env read with no define resolves to undefined,
  // which would leave the injection path compiled in.
  it.each(Object.keys(EXPECTED_DEFAULTS))(
    'compiles the E2E injection boundary out of production %s bundles',
    config => {
      const defines = defineSource(readSource(config));
      expect(occurrences(defines, `'process.env.MIDEN_E2E_TEST':`)).toBe(1);
      expect(defines).toMatch(defineEntry('MIDEN_E2E_TEST', `process.env.MIDEN_E2E_TEST ?? 'false'`));
    }
  );
});
