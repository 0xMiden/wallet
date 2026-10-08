import fs from 'fs';
import path from 'path';

import { BUNDLED_EXPLORE_ICONS } from './snapshot';
import devnet from './snapshot/devnet.json';
import testnet from './snapshot/testnet.json';
import { bundledExploreCatalog } from './source';

const ICON_DIR = path.join(__dirname, '../../app/misc/dapp-icons');

it('bundles the testnet catalog: both faucets, the Faucet featured, both as helper tools', () => {
  const catalog = bundledExploreCatalog('testnet');
  expect(catalog?.items.map(item => [item.id, item.url, item.brandColor])).toEqual([
    ['faucet', 'https://faucet.testnet.miden.io/', '#778C72'],
    ['forkchoice-faucet', 'https://faucets.forkchoice.xyz/', '#2563EB']
  ]);
  expect(catalog?.sections.map(section => [section.id, section.kind, section.itemIds])).toEqual([
    ['featured', 'featured', ['faucet']],
    ['helper-tools', 'list', ['faucet', 'forkchoice-faucet']]
  ]);
});

it('draws every bundled item with the icon file the build ships for its path, fetching none', () => {
  for (const published of [testnet, devnet]) {
    const icons = bundledExploreCatalog(published.network)?.items.map(item => item.icon);
    expect(icons).toEqual(published.items.map(item => BUNDLED_EXPLORE_ICONS[item.icon]));
    expect(icons?.every(icon => icon !== undefined && !icon.startsWith('https:'))).toBe(true);
  }
});

it('ships a file for exactly the icon paths the bundled documents name', () => {
  const named = [...new Set([...testnet.items, ...devnet.items].map(item => item.icon))].sort();
  expect(Object.keys(BUNDLED_EXPLORE_ICONS).sort()).toEqual(named);
  // Jest stubs every PNG import, so the files themselves are checked on disk.
  for (const iconPath of named) expect(fs.existsSync(path.join(ICON_DIR, path.basename(iconPath)))).toBe(true);
});

it('carries the translations the wallet shipped for the section titles and the swap faucet tagline', () => {
  const catalog = bundledExploreCatalog('testnet');
  expect(catalog?.sections.map(section => section.title.de)).toEqual(['Empfohlen', 'Hilfsprogramme']);
  expect(catalog?.items[1]?.tagline).toMatchObject({
    en: 'Get testnet tokens for swap',
    ja: 'スワップ用のテストネットトークンを入手'
  });
});

it('bundles the devnet catalog with the devnet faucet alone', () => {
  const catalog = bundledExploreCatalog('devnet');
  expect(catalog?.items.map(item => item.url)).toEqual(['https://faucet.devnet.miden.io/']);
  expect(catalog?.sections.map(section => section.itemIds)).toEqual([['faucet'], ['faucet']]);
});

it.each(['localnet', 'mainnet'])('bundles nothing for %s', network => {
  expect(bundledExploreCatalog(network)).toBeNull();
});
