import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '../../..');
// Every read drops whole-line // comments, so a define commented out with // counts as absent.
const read = (relative: string) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

const CONFIGS = fs
  .readdirSync(REPO_ROOT)
  .filter(file => /^vite\..+\.config\.ts$/.test(file))
  .sort();

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
    const source = read(config);
    expect(source).toContain(`'process.env.MIDEN_UPDATE_NOTIFICATIONS':`);
    expect(source).toContain(`process.env.MIDEN_UPDATE_NOTIFICATIONS ?? ${defaultValue}`);
  });

  it('declares the flag in ProcessEnv', () => {
    expect(read('src/react-app.d.ts')).toContain('readonly MIDEN_UPDATE_NOTIFICATIONS?: string;');
  });

  // Every bundle in which createDefaultAdapter can build the E2E adapter, plus
  // the rest for completeness: an env read with no define resolves to undefined,
  // which would leave the injection path compiled in.
  it.each(Object.keys(EXPECTED_DEFAULTS))(
    'compiles the E2E injection boundary out of production %s bundles',
    config => {
      const source = read(config);
      expect(source).toContain(`'process.env.MIDEN_E2E_TEST':`);
      expect(source).toContain(`process.env.MIDEN_E2E_TEST ?? 'false'`);
    }
  );
});
