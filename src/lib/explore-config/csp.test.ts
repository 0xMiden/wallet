import fs from 'fs';
import path from 'path';

import { PUBLISHED_EXPLORE_BASE_URL } from './source';

// The desktop app draws Explore's icons from the published repo, so its CSP has to let exactly that repo's files in.
it('lets the desktop app load the published Explore icons, and no other repository through that entry', () => {
  const conf = fs.readFileSync(path.join(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8');
  const imgSrc = /img-src ([^;"]*)/.exec(conf)?.[1]?.split(' ') ?? [];
  const icon = `${PUBLISHED_EXPLORE_BASE_URL}/icons/faucet.png`;
  expect(imgSrc.filter(source => source.startsWith('https://') && icon.startsWith(source))).toEqual([
    'https://raw.githubusercontent.com/0xMiden/wallet-explore/'
  ]);
});
