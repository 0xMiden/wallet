import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// Every config that bundles telemetry or crash reporting. An env read with no define is
// rewritten to `{}.X`, i.e. undefined, so a config missing one ships that feature off with
// no error at build time (#1118).
const CONFIGS = [
  'vite.extension.config.ts',
  'vite.background.config.ts',
  'vite.desktop.config.ts',
  'vite.mobile.config.ts'
];
const KEYS = ['APTABASE_APP_KEY', 'APTABASE_HOST', 'SENTRY_DSN'];

describe('telemetry and crash-reporting key defines', () => {
  it.each(CONFIGS.flatMap(config => KEYS.map(key => [config, key])))('%s defines %s', (config, key) => {
    expect(read(config)).toContain(`'process.env.${key}': JSON.stringify(process.env.${key} ?? '')`);
  });
});
