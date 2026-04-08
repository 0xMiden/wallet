#!/usr/bin/env node
/**
 * One-shot script: fetch the best available favicon for each featured
 * dApp, normalize to a 256×256 PNG with transparent background, and
 * write to src/app/misc/dapp-icons/${id}.png.
 *
 * Per dApp the script tries every URL in `urls` in order, parses the
 * homepage HTML for `<link rel="...icon...">` tags, scores them by
 * type + sizes (apple-touch-icon > icon, bigger sizes win, png > svg
 * > ico), downloads the winner, and converts to PNG via macOS-builtin
 * tools (sips for ico/raster, qlmanage for svg).
 *
 * Run with `node scripts/fetch-dapp-icons.mjs`. The script overwrites
 * any existing icons in src/app/misc/dapp-icons/. Verify visually
 * after running.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'src/app/misc/dapp-icons');
const TARGET_SIZE = 256;

const DAPPS = [
  { id: 'miden', urls: ['https://miden.xyz'] },
  { id: 'zoro', urls: ['https://app.zoroswap.com/'] },
  { id: 'faucet', urls: ['https://faucet.testnet.miden.io/'] },
  // beta.luminaengine.ai 500s on its homepage, but luminaengine.ai
  // serves the same icon link tag.
  { id: 'lumina', urls: ['https://beta.luminaengine.ai/', 'https://luminaengine.ai/'] }
];

function pickBestIcon(html, baseUrl) {
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const linkRe = /<link\s+[^>]*?>/gi;
  const candidates = [];
  let m;
  while ((m = linkRe.exec(cleaned)) !== null) {
    const tag = m[0];
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || '';
    if (!/(^|\s)(apple-touch-icon|icon|shortcut icon)(\s|$)/i.test(rel)) continue;
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const sizes = (tag.match(/\bsizes=["']([^"']+)["']/i) || [])[1] || '';
    const type = (tag.match(/\btype=["']([^"']+)["']/i) || [])[1] || '';
    let score = 0;
    if (/apple-touch-icon/i.test(rel)) score += 1000;
    const sizeMatch = sizes.match(/(\d+)x\d+/);
    if (sizeMatch) score += parseInt(sizeMatch[1], 10);
    if (/png/i.test(type) || /\.png(\?|$)/i.test(href)) score += 50;
    candidates.push({ score, href });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0) return null;
  return new URL(candidates[0].href, baseUrl).toString();
}

async function fetchBuf(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || '';
  return { buf, ct };
}

async function fetchOne({ id, urls }) {
  let lastErr;
  for (const homeUrl of urls) {
    try {
      const { buf: htmlBuf } = await fetchBuf(homeUrl);
      const html = htmlBuf.toString('utf-8');
      let iconUrl = pickBestIcon(html, homeUrl);
      if (!iconUrl) iconUrl = new URL('/favicon.ico', homeUrl).toString();
      console.log(`[${id}] picked ${iconUrl}`);
      const { buf, ct } = await fetchBuf(iconUrl);
      let ext = 'png';
      if (/svg/.test(ct)) ext = 'svg';
      else if (/x-icon|vnd\.microsoft\.icon/.test(ct) || iconUrl.endsWith('.ico')) ext = 'ico';
      return { buf, ext };
    } catch (e) {
      lastErr = e;
      console.warn(`[${id}] homepage ${homeUrl} failed: ${e.message}`);
    }
  }
  throw lastErr ?? new Error('all sources failed');
}

function convertToPng(srcPath, ext, outPath) {
  if (ext === 'png') {
    // Just downscale to TARGET_SIZE preserving aspect ratio.
    execFileSync('/usr/bin/sips', ['-Z', String(TARGET_SIZE), srcPath, '--out', outPath], { stdio: 'pipe' });
    return;
  }
  if (ext === 'ico') {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', srcPath, '--out', outPath], { stdio: 'pipe' });
    execFileSync('/usr/bin/sips', ['-Z', String(TARGET_SIZE), outPath, '--out', outPath], { stdio: 'pipe' });
    return;
  }
  if (ext === 'svg') {
    // qlmanage produces "<srcPath basename>.png" alongside the source,
    // so we copy it to the desired output and clean up the original.
    const tmpDir = mkdtempSync(join(tmpdir(), 'dapp-icon-svg-'));
    execFileSync('/usr/bin/qlmanage', ['-t', '-s', String(TARGET_SIZE), '-o', tmpDir, srcPath], { stdio: 'pipe' });
    const generated = join(tmpDir, `${srcPath.split('/').pop()}.png`);
    copyFileSync(generated, outPath);
    return;
  }
  throw new Error(`unknown ext ${ext}`);
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'dapp-icon-fetch-'));
  let ok = 0;
  for (const dapp of DAPPS) {
    try {
      const { buf, ext } = await fetchOne(dapp);
      const rawPath = join(tmp, `${dapp.id}.${ext}`);
      writeFileSync(rawPath, buf);
      const outPath = join(OUTPUT_DIR, `${dapp.id}.png`);
      convertToPng(rawPath, ext, outPath);
      const stat = statSync(outPath);
      console.log(`[${dapp.id}] wrote ${outPath} (${stat.size} bytes)`);
      ok++;
    } catch (e) {
      console.error(`[${dapp.id}] FAILED:`, e.message);
    }
  }
  console.log(`\n${ok}/${DAPPS.length} icons fetched.`);
  if (ok < DAPPS.length) process.exit(1);
}

main();
