import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const [traceProcessor, artifactsDir, outputPath] = process.argv.slice(2);

if (!traceProcessor || !artifactsDir || !outputPath) {
  throw new Error(
    'Usage: node scripts/analyze-native-frame-timeline.mjs <trace_processor_shell> <artifacts-dir> <output.md>'
  );
}

async function findFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findFiles(fullPath)));
    else found.push(fullPath);
  }
  return found;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ''));
    if (row.some(value => value.length > 0)) rows.push(row);
  }
  if (rows.length < 2) throw new Error('FrameTimeline query returned no frame rows');
  const [header, ...data] = rows;
  return data.map(values => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
}

function percentile(values, fraction) {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

function summarize(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const trial = Number(row.trial);
    const durationMs = Number(row.dur) / 1_000_000;
    if (!Number.isInteger(trial) || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    const list = grouped.get(trial) ?? [];
    list.push({ durationMs, jank: !['', 'NULL', 'None', 'none'].includes(row.jank_type) });
    grouped.set(trial, list);
  }

  if (grouped.size !== 5)
    throw new Error(`Expected FrameTimeline rows for all 5 native taps, found ${grouped.size} trials`);
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([trial, frames]) => {
      const durations = frames.map(frame => frame.durationMs).sort((a, b) => a - b);
      const janky = frames.filter(frame => frame.jank).length;
      return {
        trial,
        frames: frames.length,
        janky,
        jankPercent: (100 * janky) / frames.length,
        meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
        p95Ms: percentile(durations, 0.95),
        maxMs: durations.at(-1),
        durationValues: durations,
        jankyFrames: janky
      };
    });
}

function aggregate(trials) {
  const durations = trials.flatMap(trial => trial.durationValues).sort((a, b) => a - b);
  const frames = trials.reduce((sum, trial) => sum + trial.frames, 0);
  const jankyFrames = trials.reduce((sum, trial) => sum + trial.jankyFrames, 0);
  return {
    frames,
    jankyFrames,
    jankPercent: frames ? (100 * jankyFrames) / frames : 0,
    meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1)
  };
}

const files = await findFiles(artifactsDir);
const beforeTrace = files.find(file => path.basename(file) === 'frame-timeline-before.pftrace');
const afterTrace = files.find(file => path.basename(file) === 'frame-timeline-after.pftrace');
if (!beforeTrace || !afterTrace) throw new Error('Before and after FrameTimeline traces are both required');

const sql = `
WITH markers AS (
  SELECT CAST(substr(msg, 7, 1) AS INT) AS trial,
         MAX(CASE WHEN msg LIKE '%-start' THEN ts END) AS start_ts,
         MAX(CASE WHEN msg LIKE '%-end' THEN ts END) AS end_ts
  FROM android_logs
  WHERE tag = 'WalletPresentationE2E' AND msg GLOB 'trial-[1-5]-*'
  GROUP BY CAST(substr(msg, 7, 1) AS INT)
), windows AS (
  SELECT trial, start_ts, end_ts FROM markers WHERE start_ts IS NOT NULL AND end_ts > start_ts
)
SELECT w.trial, a.dur, a.jank_type
FROM actual_frame_timeline_slice AS a
JOIN windows AS w ON a.ts BETWEEN w.start_ts AND w.end_ts
WHERE a.layer_name GLOB 'TX - com.miden.wallet/*' AND a.upid IS NOT NULL AND a.dur > 0
ORDER BY w.trial, a.ts;
`;

async function analyze(trace) {
  const queryPath = `${trace}.sql`;
  await writeFile(queryPath, sql);
  const { stdout, stderr } = await execFileAsync(traceProcessor, ['query', '--format=csv', '-f', queryPath, trace], {
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return summarize(parseCsv(stdout));
}

const before = await analyze(beforeTrace);
const after = await analyze(afterTrace);
const metadataFiles = files.filter(file => /^native-presentation-(before|after)\.json$/.test(path.basename(file)));
const metadata = {};
for (const file of metadataFiles) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  metadata[value.variant] = value;
}
for (const variant of ['before', 'after']) {
  if (!metadata[variant]) throw new Error(`Missing ${variant} presentation metadata`);
}
const lines = [
  '# Android dApp presentation FrameTimeline comparison',
  '',
  'Each variant uses five native Android taps on the same API 34 emulator image. Values are measured from app-owned actual frame slices between the paired trial markers. No performance threshold is applied.',
  '',
  '| Variant | Trial | Frames | Janky | Jank % | Mean frame ms | P95 frame ms | Max frame ms |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
];

for (const [variant, trials] of [
  ['Before', before],
  ['After', after]
]) {
  for (const trial of trials) {
    lines.push(
      `| ${variant} | ${trial.trial} | ${trial.frames} | ${trial.janky} | ${trial.jankPercent.toFixed(2)}% | ${trial.meanMs.toFixed(2)} | ${trial.p95Ms.toFixed(2)} | ${trial.maxMs.toFixed(2)} |`
    );
  }
}

for (const [variant, trials] of [
  ['Before', before],
  ['After', after]
]) {
  const result = aggregate(trials);
  lines.push(
    `| ${variant} overall | 5 taps | ${result.frames} | ${result.jankyFrames} | ${result.jankPercent.toFixed(2)}% | ${result.meanMs.toFixed(2)} | ${result.p95Ms.toFixed(2)} | ${result.maxMs.toFixed(2)} |`
  );
}

lines.push(
  '',
  `Before source SHA: ${metadata.before.sourceSha}`,
  `After source SHA: ${metadata.after.sourceSha}`,
  `Trace Processor: ${traceProcessor}`,
  `Before trace: ${beforeTrace}`,
  `After trace: ${afterTrace}`,
  ''
);
await writeFile(outputPath, `${lines.join('\n')}\n`);
process.stdout.write(`${lines.join('\n')}\n`);
