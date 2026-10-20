/**
 * Renders the UI smoothness pull request comment.
 *
 * The shape matches the web-sdk proving comment: a verdict heading, a context
 * table, a Base / Head / Δ / Δ % table, a methodology disclosure, a legend and
 * a footer that says the comment never blocks merge. The number is the median
 * feel score. Lower is smoother.
 *
 * The threshold comes from ui-smoothness-profile.mjs. Nothing in the artifact
 * is allowed to choose it.
 *
 * Exit codes, matching the proving renderer:
 *   0  rendered
 *   2  bad usage
 *   3  this script or its context broke
 *   64 the artifact was refused
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DEFAULT_PROFILE, sampleCount } from './ui-smoothness-profile.mjs';

const SUBJECT = 'UI smoothness';
const EMOJI_WORSE = '🔺';
const EMOJI_BETTER = '🔻';
const EMOJI_NOISE = '➖';
const EMOJI_UNRESOLVED = '❔';

const USAGE = 'usage: node render-ui-smoothness-comment.mjs <results.json> <ctx.json>\n';

function failArtifact(message) {
  const error = new Error(message);
  error.code = 64;
  throw error;
}

function failInternal(message) {
  const error = new Error(message);
  error.code = 3;
  throw error;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatValue(value) {
  return value.toFixed(1);
}

function formatSignedValue(value) {
  const rounded = Number(value.toFixed(1));
  if (rounded === 0) return '±0.0';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toFixed(1)}`;
}

function formatPct(pct) {
  return `${Math.abs(pct).toFixed(2)}%`;
}

function formatSignedPct(pct) {
  if (pct === null) return 'n/a';
  const rounded = Number(pct.toFixed(2));
  if (rounded === 0) return '±0.00%';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%`;
}

function shortSha(sha) {
  return sha.slice(0, 7);
}

function commitLink(ctx, sha) {
  return `[\`${shortSha(sha)}\`](https://github.com/${ctx.owner}/${ctx.repo}/commit/${sha})`;
}

function readNumbers(label, raw, count) {
  if (!Array.isArray(raw) || raw.length !== count) {
    failArtifact(`${label} must be ${count} samples`);
  }
  if (raw.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    failArtifact(`${label} samples must be finite numbers`);
  }
  return raw;
}

function readSeries(name, raw, count) {
  if (!raw || typeof raw !== 'object') failArtifact(`${name} is missing`);
  const body = /** @type {{ base?: unknown, head?: unknown }} */ (raw);
  return {
    base: readNumbers(`${name} base`, body.base, count),
    head: readNumbers(`${name} head`, body.head, count)
  };
}

/**
 * @param {unknown} artifact
 */
export function readArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') failArtifact('results must be an object');
  const body = /** @type {Record<string, unknown>} */ (artifact);
  return {
    feel: readSeries('feel', body.feel, sampleCount()),
    inp: readSeries('inp', body.inp, DEFAULT_PROFILE.inpTaps),
    listDropped: readSeries('list dropped frames', body.listDropped, DEFAULT_PROFILE.listRuns),
    listP95: readSeries('list frame time', body.listP95, DEFAULT_PROFILE.listRuns)
  };
}

function readContext(raw) {
  if (!raw || typeof raw !== 'object') failInternal('context must be an object');
  const ctx = /** @type {Record<string, unknown>} */ (raw);
  const sha = value => {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) failInternal('context sha is not 40 hex chars');
    return value;
  };
  const text = (value, label) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(value)) {
      failInternal(`context ${label} is missing`);
    }
    return value;
  };
  const runId = ctx.runId;
  if (typeof runId !== 'string' || !/^[0-9]{1,20}$/.test(runId)) failInternal('context run id is missing');
  const runUrl = ctx.runUrl;
  if (typeof runUrl !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9._/-]+\/actions\/runs\/[0-9]+$/.test(runUrl)) {
    failInternal('context run url is missing');
  }
  return {
    owner: text(ctx.owner, 'owner'),
    repo: text(ctx.repo, 'repo'),
    headSha: sha(ctx.headSha),
    baseSha: sha(ctx.baseSha),
    baseRef: text(ctx.baseRef, 'baseRef'),
    runId,
    runUrl,
    runner: text(ctx.runner, 'runner')
  };
}

function deltaOf(baseValue, headValue) {
  const deltaValue = headValue - baseValue;
  const deltaPct = baseValue === 0 ? null : (deltaValue / baseValue) * 100;
  if (!Number.isFinite(deltaValue) || (deltaPct !== null && !Number.isFinite(deltaPct))) {
    failArtifact('a delta is not finite');
  }
  const magnitude = deltaPct === null ? 0 : Math.abs(deltaPct);
  const shown = Number(magnitude.toFixed(2));
  const floor = Number(DEFAULT_PROFILE.thresholdPct.toFixed(2));
  const beyond = deltaPct !== null && shown > 0 && shown >= floor;
  return { deltaValue, deltaPct, beyond, worse: deltaValue > 0 };
}

function decorate(name, unit, baseValue, headValue, forceWorse) {
  const delta = deltaOf(baseValue, headValue);
  const beyond = delta.beyond || forceWorse;
  const worse = forceWorse ? true : delta.worse;
  let emoji = EMOJI_NOISE;
  if (delta.deltaPct === null && !forceWorse) emoji = EMOJI_UNRESOLVED;
  else if (beyond) emoji = worse ? EMOJI_WORSE : EMOJI_BETTER;
  return { name, unit, baseValue, headValue, ...delta, beyond, worse, emoji, forceWorse };
}

function rowsFor(series) {
  const feel = decorate('feel', '', median(series.feel.base), median(series.feel.head), false);
  const inpBase = Math.max(...series.inp.base);
  const inpHead = Math.max(...series.inp.head);
  const inpDelta = deltaOf(inpBase, inpHead);
  const poor = inpHead > DEFAULT_PROFILE.inpPoorMs;
  const leftGood = inpBase <= DEFAULT_PROFILE.inpGoodMs && inpHead > DEFAULT_PROFILE.inpGoodMs;
  const inpForce = leftGood || (poor && !(inpDelta.beyond && !inpDelta.worse));
  const inp = decorate('inp', 'ms', inpBase, inpHead, inpForce);
  const dropped = decorate(
    'list-dropped',
    '%',
    median(series.listDropped.base),
    median(series.listDropped.head),
    false
  );
  const p95 = decorate('list-p95', 'ms', median(series.listP95.base), median(series.listP95.head), false);
  return [feel, inp, dropped, p95];
}

function headline(rows) {
  return rows.reduce((best, row) => {
    const rank = value => {
      const magnitude = Math.abs(value.deltaPct ?? 0);
      if (value.forceWorse) return 1000 + magnitude;
      if (!value.beyond) return 0;
      return magnitude;
    };
    return rank(row) > rank(best) ? row : best;
  });
}

function verdict(rows) {
  const thresholdText = `${DEFAULT_PROFILE.thresholdProvisional ? 'provisional ' : ''}±${formatPct(DEFAULT_PROFILE.thresholdPct)}`;
  const lead = headline(rows);
  if (lead.deltaPct === null && !lead.forceWorse) {
    return `### ${EMOJI_UNRESOLVED} ${SUBJECT} — No comparison possible — the base figure is zero, so a percentage would be meaningless`;
  }
  if (lead.forceWorse && lead.name === 'inp') {
    const band = lead.headValue > DEFAULT_PROFILE.inpPoorMs ? 'above 500ms' : 'above 200ms';
    return `### ${EMOJI_WORSE} ${SUBJECT} — tap response ${formatValue(lead.headValue)}ms, ${band}`;
  }
  if (!rows.some(row => row.beyond)) {
    const largest = rows.reduce((best, row) =>
      Math.abs(row.deltaPct ?? 0) > Math.abs(best.deltaPct ?? 0) ? row : best
    );
    return `### ${EMOJI_NOISE} ${SUBJECT} — No significant change (largest \`${largest.name}\` ${formatSignedPct(largest.deltaPct)}, floor ${thresholdText})`;
  }
  const direction = lead.worse ? 'rougher' : 'smoother';
  return `### ${lead.emoji} ${SUBJECT} — ${formatSignedPct(lead.deltaPct)} ${direction}: \`${lead.name}\``;
}

function provisionalNote(ctx) {
  if (!DEFAULT_PROFILE.thresholdProvisional) return '';
  return [
    `> **The noise floor is provisional.** ±${formatPct(DEFAULT_PROFILE.thresholdPct)} is a bound taken from two same-build`,
    `> runs on a developer laptop, not on \`${ctx.runner}\` — no calibration run has been recorded on this runner yet,`,
    '> so the floor on this runner is unknown in both magnitude and direction. Movements are therefore',
    '> reported as measurements rather than verdicts, however large: with the error in the floor unknown',
    '> in direction, no movement is provably clear of it. Calibrate the runner and they become rulings.'
  ].join('\n');
}

function contextTable(ctx) {
  const method = `carousel feel, tap response, and overview-list frames, on \`${ctx.runner}\` — **lower is better**`;
  return [
    '| | |',
    '| :-- | :-- |',
    `| **Head** | ${commitLink(ctx, ctx.headSha)} |`,
    `| **Base** | ${commitLink(ctx, ctx.baseSha)} (\`${ctx.baseRef}\`) |`,
    `| **Method** | ${method} |`,
    '| **Workload** | 4 numbers — `feel`, `inp`, `list-dropped`, `list-p95` |'
  ].join('\n');
}

function resultTable(rows) {
  const lines = ['| | Benchmark | Base | Head | Δ | Δ % |', '| :-: | :-- | ---: | ---: | ---: | ---: |'];
  for (const row of rows) {
    const unit = row.unit ? ` ${row.unit}` : '';
    const delta = row.deltaPct === null ? 'n/a' : formatSignedValue(row.deltaValue);
    lines.push(
      `| ${row.emoji} | \`${row.name}\` | ${formatValue(row.baseValue)}${unit} | ${formatValue(row.headValue)}${unit} | ${delta} | ${formatSignedPct(row.deltaPct)} |`
    );
  }
  return lines.join('\n');
}

function samplesBlock(series) {
  const line = (label, values) => `  ${label.padEnd(4)} ${values.map(value => formatValue(value)).join(', ')}`;
  const block = (name, values, summary) =>
    [`  ${name}`, line('base', values.base), `  base ${summary(values.base)}`, line('head', values.head), `  head ${summary(values.head)}`].join(
      '\n'
    );
  const mid = values => `median ${formatValue(median(values))}`;
  const slowest = values => `slowest ${formatValue(Math.max(...values))}`;
  return ['```text', block('feel', series.feel, mid), block('inp ms', series.inp, slowest), block('list-dropped %', series.listDropped, mid), block('list-p95 ms', series.listP95, mid), '```'].join(
    '\n'
  );
}

function methodology(ctx, samples) {
  return [
    '<details>',
    '<summary><b>Methodology and raw samples</b></summary>',
    '',
    `- \`feel\` is the median of ${sampleCount()} swipes: ${DEFAULT_PROFILE.passes} passes from ${DEFAULT_PROFILE.pageNames[0]} to ${DEFAULT_PROFILE.pageNames.at(-1)}, each pass ${DEFAULT_PROFILE.pageNames.join(' → ')}. Lower is smoother. A swipe that does not land on the next page fails the run.`,
    `- \`inp\` is the slowest of ${DEFAULT_PROFILE.inpTaps} taps on the overview copy control, in milliseconds, from Event Timing. At or below ${DEFAULT_PROFILE.inpGoodMs}ms is good and above ${DEFAULT_PROFILE.inpPoorMs}ms is poor. A tap the API does not record fails the run.`,
    `- \`list-dropped\` and \`list-p95\` are the medians of ${DEFAULT_PROFILE.listRuns} scrolls of the overview list: the share of frame gaps at or above 25ms, and the 95th percentile frame time. Lower is smoother. The run fails if the list does not move.`,
    '- A failed run posts no figure.',
    '- Both sides run on the same runner, one after the other, each in its own browser profile. The harness is the pull request\'s copy for both sides; the bundle is each side\'s own. The main thread is slowed 4×, at device pixel ratio 2, in a 600×844 frame. This is a proxy for a phone, not a phone.',
    '- The noise floor is decided by the trusted profile on the default branch, not by this artifact. The runner, the repetition count and these samples are what the measurement job reported.',
    '',
    samplesBlock(samples),
    '',
    `- Measured on \`${ctx.runner}\`.`,
    '',
    '</details>'
  ].join('\n');
}

function legend() {
  return (
    `<sub>${EMOJI_WORSE} rougher beyond the noise floor · ${EMOJI_BETTER} smoother beyond the noise floor · ` +
    `${EMOJI_UNRESOLVED} no verdict — see the heading and notes above · ${EMOJI_NOISE} within the noise floor</sub>`
  );
}

function footer(ctx) {
  return [
    '---',
    `<sub>Generated by [UI smoothness run ${ctx.runId}](${ctx.runUrl}) for \`${shortSha(ctx.headSha)}\`. ` +
      'This comment is informational only and never blocks merge.</sub>'
  ].join('\n');
}

/**
 * @param {unknown} artifact
 * @param {unknown} context
 * @returns {string}
 */
export function renderComment(artifact, context) {
  const series = readArtifact(artifact);
  const ctx = readContext(context);
  const rows = rowsFor(series);
  const moved = rows.some(row => row.beyond)
    ? [
        DEFAULT_PROFILE.thresholdProvisional
          ? '#### Moved beyond a provisional noise floor'
          : '#### Moved beyond the noise floor',
        '',
        resultTable(rows)
      ].join('\n')
    : resultTable(rows);
  return [verdict(rows), provisionalNote(ctx), contextTable(ctx), moved, methodology(ctx, series), legend(), footer(ctx)]
    .filter(Boolean)
    .join('\n\n');
}

export function noReportComment(context) {
  const ctx = readContext(context);
  return [
    `### ${EMOJI_UNRESOLVED} ${SUBJECT} — No usable report — the measurement job produced no result`,
    footer(ctx)
  ].join('\n\n');
}

function main() {
  const [resultsPath, ctxPath] = process.argv.slice(2);
  if (!resultsPath || !ctxPath) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  try {
    const artifact = JSON.parse(readFileSync(resultsPath, 'utf8'));
    const context = JSON.parse(readFileSync(ctxPath, 'utf8'));
    process.stdout.write(`${renderComment(artifact, context)}\n`);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 3;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(typeof code === 'number' ? code : 3);
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) main();
