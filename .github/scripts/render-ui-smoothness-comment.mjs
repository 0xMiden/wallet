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

import { DEFAULT_PROFILE } from './ui-smoothness-profile.mjs';

const SUBJECT = 'UI smoothness';
const BENCHMARK = 'feel';
const UNIT = 'feel';
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

function readSamples(side, raw) {
  if (!Array.isArray(raw) || raw.length !== DEFAULT_PROFILE.calibratedReps) {
    failArtifact(`${side} must be ${DEFAULT_PROFILE.calibratedReps} feel samples`);
  }
  if (raw.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    failArtifact(`${side} samples must be finite numbers`);
  }
  return raw;
}

/**
 * @param {unknown} artifact
 * @returns {{ base: number[], head: number[] }}
 */
export function readArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') failArtifact('results must be an object');
  const body = /** @type {{ base?: unknown, head?: unknown }} */ (artifact);
  return {
    base: readSamples('base', body.base),
    head: readSamples('head', body.head)
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

function rowFor(samples) {
  const baseValue = median(samples.base);
  const headValue = median(samples.head);
  const deltaValue = headValue - baseValue;
  const deltaPct = baseValue === 0 ? null : (deltaValue / baseValue) * 100;
  if (!Number.isFinite(deltaValue) || (deltaPct !== null && !Number.isFinite(deltaPct))) {
    failArtifact('the feel delta is not finite');
  }
  const magnitude = deltaPct === null ? 0 : Math.abs(deltaPct);
  const shown = Number(magnitude.toFixed(2));
  const floor = Number(DEFAULT_PROFILE.thresholdPct.toFixed(2));
  const beyond = deltaPct !== null && shown > 0 && shown >= floor;
  const worse = deltaValue > 0;
  let emoji = EMOJI_NOISE;
  if (deltaPct === null) emoji = EMOJI_UNRESOLVED;
  else if (beyond) emoji = worse ? EMOJI_WORSE : EMOJI_BETTER;
  return { baseValue, headValue, deltaValue, deltaPct, beyond, worse, emoji };
}

function verdict(row) {
  const thresholdText = `${DEFAULT_PROFILE.thresholdProvisional ? 'provisional ' : ''}±${formatPct(DEFAULT_PROFILE.thresholdPct)}`;
  if (row.deltaPct === null) {
    return `### ${EMOJI_UNRESOLVED} ${SUBJECT} — No comparison possible — the base figure is zero, so a percentage would be meaningless`;
  }
  if (!row.beyond) {
    return `### ${EMOJI_NOISE} ${SUBJECT} — No significant change (largest \`${BENCHMARK}\` ${formatSignedPct(row.deltaPct)}, floor ${thresholdText})`;
  }
  const direction = row.worse ? 'rougher' : 'smoother';
  return `### ${row.emoji} ${SUBJECT} — ${formatSignedPct(row.deltaPct)} ${direction}: \`${BENCHMARK}\``;
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
  const method =
    `median of ${DEFAULT_PROFILE.calibratedReps} swipes, feel score, on \`${ctx.runner}\` — **lower is better**`;
  return [
    '| | |',
    '| :-- | :-- |',
    `| **Head** | ${commitLink(ctx, ctx.headSha)} |`,
    `| **Base** | ${commitLink(ctx, ctx.baseSha)} (\`${ctx.baseRef}\`) |`,
    `| **Method** | ${method} |`,
    `| **Workload** | 1 benchmark (${UNIT}) — \`${BENCHMARK}\` |`
  ].join('\n');
}

function resultTable(row) {
  const delta = row.deltaPct === null ? 'n/a' : formatSignedValue(row.deltaValue);
  return [
    `| | Benchmark | Base (${UNIT}) | Head (${UNIT}) | Δ | Δ % |`,
    '| :-: | :-- | ---: | ---: | ---: | ---: |',
    `| ${row.emoji} | \`${BENCHMARK}\` | ${formatValue(row.baseValue)} | ${formatValue(row.headValue)} | ${delta} | ${formatSignedPct(row.deltaPct)} |`
  ].join('\n');
}

function samplesBlock(samples) {
  const line = (label, values) => `  ${label.padEnd(4)} ${values.map(value => formatValue(value)).join(', ')}`;
  return [
    '```text',
    `  ${BENCHMARK}`,
    line('base', samples.base),
    `  base median ${formatValue(median(samples.base))} ${UNIT}`,
    line('head', samples.head),
    `  head median ${formatValue(median(samples.head))} ${UNIT}`,
    '```'
  ].join('\n');
}

function methodology(ctx, samples) {
  return [
    '<details>',
    '<summary><b>Methodology and raw samples</b></summary>',
    '',
    '- The number is the median feel score of six swipes from Overview to Send. Lower is smoother. A swipe that does not land on the next page fails the run, and a failed run posts no figure.',
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
  const samples = readArtifact(artifact);
  const ctx = readContext(context);
  const row = rowFor(samples);
  const moved = row.beyond
    ? [
        DEFAULT_PROFILE.thresholdProvisional
          ? '#### Moved beyond a provisional noise floor'
          : '#### Moved beyond the noise floor',
        '',
        resultTable(row)
      ].join('\n')
    : resultTable(row);
  return [
    verdict(row),
    provisionalNote(ctx),
    contextTable(ctx),
    moved,
    methodology(ctx, samples),
    legend(),
    footer(ctx)
  ]
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
