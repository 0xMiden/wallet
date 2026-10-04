import {
  defineEntry,
  defineSource,
  envReads,
  listSources,
  occurrences,
  readSource,
  viteConfigs
} from '../testing/define-parity';

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

// Every env read in the remote-config modules except the E2E flag, which is pinned above, must be forwarded as the
// raw value with an empty default. A config missing one would bake `{}.X`, i.e. undefined, into that bundle, and its
// E2E build would read the published repo instead of the served document. A later read with a different default
// fails here on purpose, until the case is written for it.
const REMOTE_CONFIG_KEYS = [
  ...new Set(listSources('src/lib/remote-config').flatMap(file => envReads(readSource(file))))
]
  .filter(key => key !== 'MIDEN_E2E_TEST' && key !== 'NODE_ENV')
  .sort();

describe('remote config defines', () => {
  it('finds the served-document URL among the remote-config env reads', () => {
    // A read moved out of the module would otherwise drop out of the cases below unpinned.
    expect(REMOTE_CONFIG_KEYS).toEqual(expect.arrayContaining(['MIDEN_REMOTE_CONFIG_URL']));
  });

  it.each(CONFIGS.flatMap(config => REMOTE_CONFIG_KEYS.map(key => [config, key])))(
    '%s forwards %s with an empty default',
    (config, key) => {
      const defines = defineSource(readSource(config));
      expect(occurrences(defines, `'process.env.${key}':`)).toBe(1);
      expect(defines).toMatch(defineEntry(key, `process.env.${key} ?? ''`));
    }
  );
});
