import { defineSource, envReads, listSources, readSource, viteConfigs } from 'lib/testing/define-parity';

// The Epoch hosts come from the bridge config at runtime; a build-time define would pin a bundle to one deployment.
describe('Epoch hosts at build time', () => {
  it('finds the build configs', () => {
    expect(viteConfigs()).toEqual(
      expect.arrayContaining([
        'vite.background.config.ts',
        'vite.contentScripts.config.ts',
        'vite.desktop.config.ts',
        'vite.extension.config.ts',
        'vite.mobile.config.ts'
      ])
    );
  });

  it.each(viteConfigs())('%s defines no Epoch host and no bridge UI switch', config => {
    expect(defineSource(readSource(config))).not.toMatch(/process\.env\.(EPOCH_|MIDEN_ENABLE_BRIDGE_UI)/);
  });

  it('no Epoch module reads an Epoch host from the environment', () => {
    const reads = listSources('src/lib/epoch').flatMap(file => envReads(readSource(file)));
    expect(reads.filter(name => name.startsWith('EPOCH_'))).toEqual([]);
  });
});
