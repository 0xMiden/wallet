import { defineEntry, defineSource, readSource, viteConfigs } from '../testing/define-parity';

// Discover configs matching /^vite\..+\.config\.ts$/ (every bundle that can reach a live
// WalletConnect flow; contentScripts never does). A config missing the raw-env define would
// quietly bake in config.ts's own default and never honour an override, so every one of
// these must carry the define below with no literal default of its own.
const CONFIGS = viteConfigs().filter(file => file !== 'vite.contentScripts.config.ts');

describe('WalletConnect project id define parity', () => {
  it('finds the build configs that bundle WalletConnect', () => {
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

  it.each(CONFIGS)('%s forwards the raw WALLETCONNECT_PROJECT_ID', config => {
    expect(defineSource(readSource(config))).toMatch(
      defineEntry('WALLETCONNECT_PROJECT_ID', "process.env.WALLETCONNECT_PROJECT_ID ?? ''")
    );
  });

  it.each(CONFIGS)('%s carries no default of its own', config => {
    expect(readSource(config)).not.toContain('d18d112eb50cbe764f03e51a90210611');
  });
});
