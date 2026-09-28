import { defineEntry, defineSource, readSource, viteConfigs } from '../testing/define-parity';

// Pinned to the four bundles that reach a live WalletConnect flow (contentScripts never does).
// A config missing the define would quietly bake its own value while the others honour an
// override, since the default lives only in src/lib/walletconnect/config.ts.
const CONFIG_NAMES = [
  'vite.background.config.ts',
  'vite.desktop.config.ts',
  'vite.extension.config.ts',
  'vite.mobile.config.ts'
];
const CONFIGS = viteConfigs().filter(file => CONFIG_NAMES.includes(file));

describe('WalletConnect project id define parity', () => {
  it('finds the build configs that bundle WalletConnect', () => {
    // A config renamed out of the pattern would otherwise drop out of the cases below unpinned.
    expect(CONFIGS).toEqual(CONFIG_NAMES);
  });

  it.each(CONFIG_NAMES)('%s forwards the raw WALLETCONNECT_PROJECT_ID', config => {
    expect(defineSource(readSource(config))).toMatch(
      defineEntry('WALLETCONNECT_PROJECT_ID', "process.env.WALLETCONNECT_PROJECT_ID ?? ''")
    );
  });

  it.each(CONFIG_NAMES)('%s carries no default of its own', config => {
    expect(readSource(config)).not.toContain('d18d112eb50cbe764f03e51a90210611');
  });
});
