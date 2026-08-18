#!/usr/bin/env node
// Build a static, browsable gallery of the E2E screenshot filmstrips.
//
// Input: a staging directory whose immediate subdirectories are the downloaded
// artifacts (one per E2E job), each containing the harness output tree
//   run-<ts>/tests/<spec>/screens/screen-NNN-<key>-wallet-<x>.png
// Output: a self-contained static site (index.html + assets/) suitable for
// GitHub Pages. Screenshots are copied (not inlined) so the page stays light.
//
// Usage:
//   node scripts/build-e2e-gallery.mjs \
//     --input <stagingDir> --output <siteDir> \
//     [--sha <gitSha>] [--run-url <url>] [--generated-at <iso>] [--branch main]

import * as fs from 'node:fs';
import * as path from 'node:path';

/* ---------- args ---------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k || !k.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const INPUT = args.input;
const OUTPUT = args.output;
if (!INPUT || !OUTPUT) {
  console.error(
    'usage: build-e2e-gallery.mjs --input <dir> --output <dir> [--sha ..] [--run-url ..] [--generated-at ..] [--branch ..]'
  );
  process.exit(1);
}
const SHA = args.sha || '';
const RUN_URL = args['run-url'] || '';
const BRANCH = args.branch || 'main';
const GENERATED_AT = args['generated-at'] || new Date().toISOString();

/* ---------- friendly labels for artifact/job names ---------- */
// Longest-prefix wins; falls back to a title-cased version of the raw name.
const JOB_LABELS = [
  ['chrome-guardian-e2e', 'Guardian (Chrome)'],
  ['chrome-e2e', 'Wallet (Chrome)'],
  ['mobile-guardian-e2e', 'Guardian (iOS)'],
  ['mobile-e2e', 'Wallet (iOS)'],
  ['bridge-in-e2e', 'Bridge-IN (iOS)'],
  ['android-e2e', 'Wallet (Android)'],
  ['swap-e2e', 'Swap (Chrome)'],
  ['earn-e2e', 'Earn (Chrome)'],
  ['guardian-lifecycle-e2e', 'Guardian Lifecycle (Chrome)'],
  ['bridge-guardian-e2e', 'Guardian Bridge-Out (Chrome)'],
  ['bridge-e2e', 'Bridge-Out (Chrome)'],
  ['resilience', 'Infra Resilience (Chrome)'],
  ['local-e2e', 'Core (Chrome, localnet)']
];
function jobLabel(name) {
  for (const [prefix, label] of JOB_LABELS) if (name.includes(prefix)) return label;
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* ---------- discovery ---------- */
function walk(dir, hits) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hits);
    else if (e.isFile() && /screen-\d+.*\.png$/i.test(e.name) && /(^|\/)screens\//.test(p.replace(/\\/g, '/')))
      hits.push(p);
  }
}

// From a full path, extract the spec folder name (the dir right above screens/).
function specOf(pngPath) {
  const parts = pngPath.replace(/\\/g, '/').split('/');
  const si = parts.lastIndexOf('screens');
  return si > 0 ? parts[si - 1] : 'unknown-spec';
}
// A shorter, human-facing spec title from the harness folder name.
function specTitle(specDir) {
  // e.g. "swap-cancel.spec.ts-swap-_cancel_-_reclaim-A_offers_10_SWPA-..."
  let s = specDir.replace(/\.spec\.ts.*$/i, m => m.replace(/^\.spec\.ts-?/i, ' — '));
  s = s.replace(/\.(ts|js)-/i, ' — ');
  s = s.replace(/[_]+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return s || specDir;
}
function screenIndex(file) {
  const m = /screen-(\d+)/i.exec(file);
  return m ? Number(m[1]) : 0;
}
// The screen "key" caption from the filename: screen-007-swap-SwapAmounts-drawer-swap-token-wallet-a.png
function screenCaption(file) {
  let s = file.replace(/\.png$/i, '').replace(/^screen-\d+-/i, '');
  const wm = /-wallet-([ab])$/i.exec(s);
  const wallet = wm ? wm[1].toUpperCase() : '';
  s = s.replace(/-wallet-[ab]$/i, '');
  return { key: s.replace(/-/g, ' › '), wallet };
}
function slug(s) {
  return s
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/* ---------- collect ---------- */
const jobs = [];
let totalShots = 0;
let totalSpecs = 0;
const jobDirs = fs
  .readdirSync(INPUT, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)
  .sort();

for (const jobName of jobDirs) {
  const hits = [];
  walk(path.join(INPUT, jobName), hits);
  if (hits.length === 0) continue;
  const specsMap = new Map();
  for (const png of hits) {
    const spec = specOf(png);
    if (!specsMap.has(spec)) specsMap.set(spec, []);
    specsMap.get(spec).push(png);
  }
  const specs = [];
  for (const [specDir, pngs] of specsMap) {
    pngs.sort((a, b) => screenIndex(path.basename(a)) - screenIndex(path.basename(b)) || a.localeCompare(b));
    const shots = pngs.map(src => {
      const file = path.basename(src);
      const rel = path.join('assets', slug(jobName), slug(specDir), file);
      const dest = path.join(OUTPUT, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      const cap = screenCaption(file);
      return { rel, idx: screenIndex(file), key: cap.key, wallet: cap.wallet };
    });
    specs.push({ title: specTitle(specDir), raw: specDir, shots });
    totalShots += shots.length;
  }
  specs.sort((a, b) => a.title.localeCompare(b.title));
  totalSpecs += specs.length;
  jobs.push({ name: jobName, label: jobLabel(jobName), specs, count: specs.reduce((n, s) => n + s.shots.length, 0) });
}

/* ---------- render ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shortSha = SHA ? SHA.slice(0, 8) : '';
const commitLink = SHA ? `https://github.com/0xMiden/wallet/commit/${SHA}` : '';

const CSS = `
:root{
  --bg:#f7f6f3; --surface:#ffffff; --surface-2:#f1efe9; --border:#e4e0d6;
  --ink:#211d17; --muted:#6f685c; --faint:#a49c8d;
  --accent:#e8590c; --accent-ink:#ffffff; --ring:#f0863f;
  --shadow:0 1px 2px rgba(33,29,23,.06),0 8px 24px rgba(33,29,23,.06);
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#17150f; --surface:#201d15; --surface-2:#262218; --border:#332e22;
  --ink:#f2ede2; --muted:#a89f8e; --faint:#726954;
  --accent:#f0863f; --accent-ink:#17150f; --ring:#f0863f;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --bg:#17150f; --surface:#201d15; --surface-2:#262218; --border:#332e22;
  --ink:#f2ede2; --muted:#a89f8e; --faint:#726954;
  --accent:#f0863f; --accent-ink:#17150f; --ring:#f0863f;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1200px;margin:0 auto;padding:0 24px}
header.top{border-bottom:1px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:5;box-shadow:var(--shadow)}
.top .wrap{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;padding-top:18px;padding-bottom:18px}
.title{font-size:20px;font-weight:700;letter-spacing:-.01em;margin:0}
.title .dot{color:var(--accent)}
.meta{font-family:var(--mono);font-size:12.5px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap;margin-left:auto}
.meta b{color:var(--ink);font-weight:600}
.summary{display:flex;gap:10px;flex-wrap:wrap;padding:22px 0 6px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 14px;box-shadow:var(--shadow)}
.stat .n{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.toc{display:flex;gap:8px;flex-wrap:wrap;padding:8px 0 18px}
.toc a{background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:5px 12px;font-size:12.5px;color:var(--ink)}
.toc a:hover{border-color:var(--ring);text-decoration:none}
.toc a .c{color:var(--muted);font-variant-numeric:tabular-nums}
section.job{margin:14px 0 34px}
.job > h2{font-size:16px;margin:0 0 2px;display:flex;align-items:center;gap:10px}
.job > h2 .badge{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:1px 7px;font-weight:500}
.job > .raw{font-family:var(--mono);font-size:11px;color:var(--faint);margin:0 0 14px}
.spec{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin:12px 0;box-shadow:var(--shadow)}
.spec h3{font-size:14px;margin:0 0 12px;font-weight:650;text-wrap:balance}
.strip{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin}
.frame{flex:0 0 auto;width:150px;cursor:zoom-in;border:0;background:none;padding:0;text-align:left;font:inherit;color:inherit}
.frame .thumbwrap{position:relative;border:1px solid var(--border);border-radius:9px;overflow:hidden;background:var(--surface-2);aspect-ratio:9/16}
.frame img{width:100%;height:100%;object-fit:contain;display:block;background:var(--surface-2)}
.frame .num{position:absolute;top:6px;left:6px;font-family:var(--mono);font-size:10px;background:rgba(0,0,0,.62);color:#fff;border-radius:5px;padding:1px 5px}
.frame .wl{position:absolute;top:6px;right:6px;font-family:var(--mono);font-size:10px;font-weight:700;background:var(--accent);color:var(--accent-ink);border-radius:5px;padding:1px 5px}
.frame:hover .thumbwrap{border-color:var(--ring)}
.frame:focus-visible{outline:2px solid var(--ring);outline-offset:3px;border-radius:9px}
.frame .cap{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-top:6px;line-height:1.35;word-break:break-word}
footer{border-top:1px solid var(--border);color:var(--muted);font-size:12.5px;padding:24px 0 48px;margin-top:20px}
.empty{padding:60px 0;color:var(--muted);text-align:center}
/* lightbox */
.lb{position:fixed;inset:0;background:rgba(10,8,4,.86);display:none;align-items:center;justify-content:center;z-index:50;padding:20px}
.lb.open{display:flex}
.lb img{max-width:min(92vw,700px);max-height:88vh;object-fit:contain;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.lb .cap{position:fixed;bottom:16px;left:0;right:0;text-align:center;color:#f2ede2;font-family:var(--mono);font-size:12.5px;padding:0 20px}
.lb button{position:fixed;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:10px;width:44px;height:44px;font-size:20px;cursor:pointer}
.lb .x{top:16px;right:16px}
.lb .prev{left:16px;top:50%;transform:translateY(-50%)}
.lb .next{right:16px;top:50%;transform:translateY(-50%)}
.lb button:hover{background:rgba(255,255,255,.2)}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

function renderJob(job) {
  const specs = job.specs
    .map(
      spec => `
      <div class="spec">
        <h3>${esc(spec.title)}</h3>
        <div class="strip">
          ${spec.shots
            .map(
              s => `<button class="frame" data-src="${esc(s.rel)}" data-cap="${esc(s.key)}${s.wallet ? ' · wallet ' + s.wallet : ''}">
              <span class="thumbwrap"><img loading="lazy" src="${esc(s.rel)}" alt="${esc(s.key)}">
                <span class="num">${String(s.idx).padStart(3, '0')}</span>${s.wallet ? `<span class="wl">${esc(s.wallet)}</span>` : ''}</span>
              <span class="cap">${esc(s.key)}</span></button>`
            )
            .join('\n')}
        </div>
      </div>`
    )
    .join('\n');
  return `
    <section class="job" id="${esc(slug(job.name))}">
      <h2>${esc(job.label)} <span class="badge">${job.specs.length} spec${job.specs.length === 1 ? '' : 's'} · ${job.count} shots</span></h2>
      <p class="raw">${esc(job.name)}</p>
      ${specs}
    </section>`;
}

const toc = jobs
  .map(j => `<a href="#${esc(slug(j.name))}">${esc(j.label)} <span class="c">${j.count}</span></a>`)
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wallet E2E Screenshots</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <h1 class="title">Wallet E2E Screenshots<span class="dot">.</span></h1>
  <div class="meta">
    <span>branch <b>${esc(BRANCH)}</b></span>
    ${shortSha ? `<span>commit <b><a href="${esc(commitLink)}">${esc(shortSha)}</a></b></span>` : ''}
    ${RUN_URL ? `<span><a href="${esc(RUN_URL)}">CI run ↗</a></span>` : ''}
    <span>generated <b>${esc(GENERATED_AT.replace('T', ' ').replace(/\..*/, ' UTC'))}</b></span>
  </div>
</div></header>

<main class="wrap">
  ${
    jobs.length === 0
      ? `<p class="empty">No screenshots found in this run's artifacts.</p>`
      : `
  <div class="summary">
    <div class="stat"><div class="n">${jobs.length}</div><div class="l">Jobs</div></div>
    <div class="stat"><div class="n">${totalSpecs}</div><div class="l">Specs</div></div>
    <div class="stat"><div class="n">${totalShots}</div><div class="l">Screenshots</div></div>
  </div>
  <nav class="toc">${toc}</nav>
  ${jobs.map(renderJob).join('\n')}`
  }
</main>

<footer><div class="wrap">Generated from E2E screenshot artifacts by <code>scripts/build-e2e-gallery.mjs</code>. Every frame is one screen-change captured during a test.</div></footer>

<div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="Screenshot viewer">
  <button class="x" aria-label="Close">×</button>
  <button class="prev" aria-label="Previous">‹</button>
  <button class="next" aria-label="Next">›</button>
  <img alt="">
  <div class="cap"></div>
</div>

<script>
(function(){
  var frames = Array.prototype.slice.call(document.querySelectorAll('.frame'));
  var lb = document.getElementById('lb');
  var img = lb.querySelector('img'), cap = lb.querySelector('.cap');
  var i = -1;
  function show(n){
    if(n<0||n>=frames.length) return;
    i=n; var f=frames[n];
    img.src=f.getAttribute('data-src'); img.alt=f.getAttribute('data-cap');
    cap.textContent=(n+1)+' / '+frames.length+'  ·  '+f.getAttribute('data-cap');
    lb.classList.add('open');
  }
  function close(){lb.classList.remove('open'); img.src='';}
  frames.forEach(function(f,n){f.addEventListener('click',function(){show(n);});});
  lb.querySelector('.x').addEventListener('click',close);
  lb.querySelector('.prev').addEventListener('click',function(e){e.stopPropagation();show(i-1);});
  lb.querySelector('.next').addEventListener('click',function(e){e.stopPropagation();show(i+1);});
  lb.addEventListener('click',function(e){if(e.target===lb)close();});
  document.addEventListener('keydown',function(e){
    if(!lb.classList.contains('open'))return;
    if(e.key==='Escape')close();
    else if(e.key==='ArrowRight')show(i+1);
    else if(e.key==='ArrowLeft')show(i-1);
  });
})();
</script>
</body>
</html>`;

fs.mkdirSync(OUTPUT, { recursive: true });
fs.writeFileSync(path.join(OUTPUT, 'index.html'), html);
console.log(
  `gallery: ${jobs.length} jobs, ${totalSpecs} specs, ${totalShots} screenshots -> ${path.join(OUTPUT, 'index.html')}`
);
