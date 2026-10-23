import fs from 'fs';
import path from 'path';

// The published config repo, whose `icons/` hold the Earn vault logos the document names.
const PUBLISHED_CONFIG_BASE = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');

// The desktop app draws the vault logos from the published repo, so its CSP has to let exactly that repo's files in.
it('lets the desktop app load the published vault logos, and no other repository through that entry', () => {
  const imgSrc = /img-src ([^;"]*)/.exec(read('src-tauri/tauri.conf.json'))?.[1]?.split(' ') ?? [];
  const logo = `${PUBLISHED_CONFIG_BASE}/icons/aave.svg`;
  expect(imgSrc.filter(source => source.startsWith('https://') && logo.startsWith(source))).toEqual([
    'https://raw.githubusercontent.com/0xMiden/wallet-config/'
  ]);
});

// The extension pages run cross-origin isolated, so a cross-origin image loads only as a CORS request
// (`ProviderLogo` sets `crossOrigin="anonymous"`, which the repo's `Access-Control-Allow-Origin: *` answers). Their
// CSP names no `img-src` or `default-src`, so it does not restrict images.
it('runs the extension pages under require-corp with a CSP that does not restrict images', () => {
  const manifest = read('public/manifest.json');
  expect(manifest).toMatch(/"cross_origin_embedder_policy":\s*\{\s*"value":\s*"require-corp"\s*\}/);
  const csp = /"extension_pages":\s*"([^"]*)"/.exec(manifest)?.[1];
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toMatch(/(^|;)\s*(img-src|default-src)\b/);
});
