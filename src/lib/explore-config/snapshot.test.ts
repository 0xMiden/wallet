import fs from 'fs';
import path from 'path';

import { BUNDLED_EXPLORE_ICONS } from './snapshot';
import devnet from './snapshot/devnet.json';
import testnet from './snapshot/testnet.json';
import { bundledExploreCatalog } from './source';

const ICON_DIR = path.join(__dirname, '../../app/misc/dapp-icons');

it('bundles both testnet faucets, Where Legends Grow and port0 in their published sections', () => {
  const catalog = bundledExploreCatalog('testnet');
  expect(catalog?.items.map(item => [item.id, item.url, item.brandColor])).toEqual([
    ['faucet', 'https://faucet.testnet.miden.io/', '#778C72'],
    ['forkchoice-faucet', 'https://faucets.forkchoice.xyz/', '#2563EB'],
    ['where-legends-grow', 'https://wherelegendsgrow.com/', '#07101F'],
    ['port0', 'https://testnet.port0.sh/', '#F200B9']
  ]);
  expect(catalog?.sections.map(section => [section.id, section.kind, section.itemIds])).toEqual([
    ['featured', 'featured', ['faucet']],
    ['helper-tools', 'list', ['faucet', 'forkchoice-faucet']],
    ['defi', 'list', ['port0']],
    ['games', 'list', ['where-legends-grow']]
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

it('carries the published translations for section titles and the swap faucet and game taglines', () => {
  const catalog = bundledExploreCatalog('testnet');
  // The published DeFi title is English only.
  expect(catalog?.sections.map(section => section.title.de)).toEqual([
    'Empfohlen',
    'Hilfsprogramme',
    undefined,
    'Spiele'
  ]);
  expect(catalog?.items[1]?.tagline).toMatchObject({
    en: 'Get testnet tokens for swap',
    ja: 'スワップ用のテストネットトークンを入手'
  });
  expect(catalog?.items[2]?.tagline).toMatchObject({
    en: 'Build a football club, train your squad and play matches',
    ja: 'サッカークラブを作り、選手を育てて試合に挑む'
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
