import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// Strip whole-line // comments so a commented-out define fails the test.
const stripComments = (content: string) =>
  content
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

// Discover configs matching /^vite\..+\.config\.ts$/ (every config that bundles telemetry
// or crash reporting). An env read with no define is rewritten to `{}.X`, i.e. undefined,
// so a config missing one ships that feature off with no error at build time (#1118).
// contentScripts bundle no telemetry, and an undefined read resolves to '' (off).
const CONFIGS = fs
  .readdirSync(REPO_ROOT)
  .filter(file => /^vite\..+\.config\.ts$/.test(file))
  .filter(file => file !== 'vite.contentScripts.config.ts')
  .sort();

// Every env read in the telemetry modules is a key the configs must define. NODE_ENV is defined in
// every config too, but with a 'development' default rather than ''.
const TELEMETRY_DIR = 'src/lib/telemetry';
const KEYS = [
  ...new Set(
    fs
      .readdirSync(path.join(REPO_ROOT, TELEMETRY_DIR))
      .filter(file => /\.tsx?$/.test(file) && !file.includes('.test.'))
      .flatMap(file =>
        [...read(`${TELEMETRY_DIR}/${file}`).matchAll(/process\.env\??\.([A-Z0-9_]+)/g)].map(match => match[1]!)
      )
  )
]
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

  it.each(CONFIGS.flatMap(config => KEYS.map(key => [config, key])))('%s defines %s', (config, key) => {
    const content = stripComments(read(config));
    expect(content).toContain(`'process.env.${key}': JSON.stringify(process.env.${key} ?? '')`);
  });

  it('vite.extension.config.ts spreads sharedDefine into its define block', () => {
    const content = read('vite.extension.config.ts');
    // The keys live in sharedDefine; dropping the spread would ship them off.
    expect(content).toContain('...sharedDefine,');
  });
});
