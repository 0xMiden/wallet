import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const EXPECTED_DEFAULTS: Record<string, string> = {
  'vite.extension.config.ts': "(TARGET_BROWSER === 'chrome' ? 'true' : 'false')",
  'vite.background.config.ts': "(TARGET_BROWSER === 'chrome' ? 'true' : 'false')",
  'vite.contentScripts.config.ts': "'false'",
  'vite.mobile.config.ts': "'true'",
  'vite.desktop.config.ts': "'false'"
};

describe('update notification build-time flag', () => {
  it.each(Object.entries(EXPECTED_DEFAULTS))('%s defines the supported-platform default', (config, defaultValue) => {
    const source = read(config);
    expect(source).toContain(`'process.env.MIDEN_UPDATE_NOTIFICATIONS':`);
    expect(source).toContain(`process.env.MIDEN_UPDATE_NOTIFICATIONS ?? ${defaultValue}`);
  });

  it('declares the flag in ProcessEnv', () => {
    expect(read('src/react-app.d.ts')).toContain('readonly MIDEN_UPDATE_NOTIFICATIONS?: string;');
  });

  it('compiles the E2E injection boundary out of production desktop bundles', () => {
    const source = read('vite.desktop.config.ts');
    expect(source).toContain(`'process.env.MIDEN_E2E_TEST':`);
    expect(source).toContain(`process.env.MIDEN_E2E_TEST ?? 'false'`);
  });
});
