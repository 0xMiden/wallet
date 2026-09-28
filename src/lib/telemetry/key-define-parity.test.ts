import {
  defineEntry,
  defineSource,
  envReads,
  listSources,
  occurrences,
  readSource,
  viteConfigs
} from '../testing/define-parity';

// Discover configs matching /^vite\..+\.config\.ts$/ (every config that bundles telemetry
// or crash reporting). An env read with no define is rewritten to `{}.X`, i.e. undefined,
// so a config missing one ships that feature off with no error at build time (#1118).
// contentScripts bundle no telemetry, and an undefined read resolves to '' (off).
const CONFIGS = viteConfigs().filter(file => file !== 'vite.contentScripts.config.ts');

// Every env read in the telemetry modules is a key the configs must define. NODE_ENV is defined in
// every config too, but with a 'development' default rather than ''.
const KEYS = [...new Set(listSources('src/lib/telemetry').flatMap(file => envReads(readSource(file))))]
  .filter(key => key !== 'NODE_ENV')
  .sort();

describe('telemetry and crash-reporting key defines', () => {
  it('finds the usage-data and crash-reporting keys in the telemetry modules', () => {
    // A key read moved out of these modules would otherwise drop out of the cases below unpinned.
    expect(KEYS).toEqual(expect.arrayContaining(['APTABASE_APP_KEY', 'APTABASE_HOST', 'SENTRY_DSN']));
  });

  it('finds the build configs that bundle telemetry', () => {
    // A config renamed out of the pattern would otherwise drop out of the cases below unpinned.
    expect(CONFIGS).toEqual(
      expect.arrayContaining([
        'vite.background.config.ts',
        'vite.desktop.config.ts',
        'vite.extension.config.ts',
        'vite.mobile.config.ts'
      ])
    );
  });

  // Matched in what reaches `define`, so the extension config's keys count only while its define block
  // spreads sharedDefine.
  it.each(CONFIGS.flatMap(config => KEYS.map(key => [config, key])))('%s defines %s', (config, key) => {
    const defines = defineSource(readSource(config));
    expect(defines).toMatch(defineEntry(key, `process.env.${key} ?? ''`));
    expect(occurrences(defines, `'process.env.${key}':`)).toBe(1);
  });
});
