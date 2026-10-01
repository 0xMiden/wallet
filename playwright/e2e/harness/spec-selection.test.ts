import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { listPlaywrightTests } from './playwright-list';

/**
 * The dedicated-suite configs spread `playwright.e2e.config`, whose `testIgnore`
 * excludes the very directories those suites exist to run (`**​/swap/**`,
 * `**​/resilience/**`). Inheriting it selects NOTHING — and a Playwright run that
 * matches no spec exits 0, so the job reads green while covering nothing. Each
 * config must therefore override `testIgnore` explicitly.
 *
 * Asserted on the config SOURCE rather than by importing it: `defineConfig`
 * returns the object unchanged, so the override is exactly this literal, and
 * reading the file keeps @playwright/test out of the jest module graph.
 */
const repoRoot = resolve(__dirname, '../../..');

const configSource = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');

/** The json reports a real Playwright run leaves; listing tests must not rewrite them. */
const reportFiles = ['test-results/results.json', 'test-results-stress/results.json'];
const reportStamp = (file: string) => statSync(resolve(repoRoot, file), { throwIfNoEntry: false })?.mtimeMs ?? null;
let reportsBefore: (number | null)[];

beforeAll(() => {
  reportsBefore = reportFiles.map(reportStamp);
});

/** Configs whose testDir the base config ignores. */
const overridingConfigs = ['playwright.resilience.config.ts', 'playwright.swap.config.ts'];

describe('dedicated e2e configs override the base testIgnore', () => {
  it.each(overridingConfigs)('%s clears the inherited ignore list', file => {
    const testIgnore = /testIgnore:\s*(.+)/.exec(configSource(file))?.[1];
    expect(testIgnore).toMatch(/^undefined,?$/);
  });

  it('the base config is the reason the override is required', () => {
    const base = configSource('playwright.e2e.config.ts');
    const testIgnore = /testIgnore:\s*(.+)/.exec(base)?.[1];
    expect(testIgnore).toMatch(/resilience/);
    expect(testIgnore).toMatch(/swap/);
  });
});

function listGuardianTests(suite?: string): string {
  return listPlaywrightTests('playwright.guardian.config.ts', { GUARDIAN_E2E_SUITE: suite });
}

const MAIN_ONLY = [
  'guardian-fault.smoke.spec.ts',
  'guardian-recovery-stress.spec.ts',
  'guardian-switch-stress.spec.ts'
];

describe('guardian e2e suite split', () => {
  let prList: string;
  let fullList: string;
  let fullNamedList: string;

  beforeAll(() => {
    prList = listGuardianTests('pr');
    fullList = listGuardianTests();
    fullNamedList = listGuardianTests('full');
  });

  it('PR suite drops stress and fault.smoke', () => {
    for (const spec of MAIN_ONLY) {
      expect(prList).not.toContain(spec);
    }
    expect(prList).toContain('guardian-onboarding-create.spec.ts');
    expect(prList).toContain('guardian-send-consume.spec.ts');
    expect(prList).toContain('guardian-switch.spec.ts');
  });

  it('full suite (unset or GUARDIAN_E2E_SUITE=full) keeps stress and fault.smoke', () => {
    for (const spec of MAIN_ONLY) {
      expect(fullList).toContain(spec);
      expect(fullNamedList).toContain(spec);
    }
  });

  it('the on-disk guardian specs still include the main-only files', () => {
    const root = resolve(repoRoot, 'playwright/e2e/tests');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/^guardian-.*\.spec\.ts$/.test(ent.name)) files.push(ent.name);
      }
    };
    walk(root);
    expect(files.sort()).toEqual(expect.arrayContaining(MAIN_ONLY));
  });
});

describe('PR workflows skip the heavy swap and earn jobs', () => {
  it('swap-e2e is skipped on pull_request', () => {
    const src = configSource('.github/workflows/pr-e2e-swap.yml');
    expect(src).toMatch(/if: github\.event_name != 'pull_request'/);
  });

  it('earn-e2e is skipped on pull_request', () => {
    const src = configSource('.github/workflows/pr-e2e-earn.yml');
    expect(src).toMatch(/if: github\.event_name != 'pull_request'/);
    expect(src).not.toMatch(/select-earn-e2e/);
  });

  it('local-e2e has no fast-blocks matrix and uses 500ms blocks', () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    expect(src).not.toMatch(/fast blocks/);
    expect(matrixJobIds(LOCAL, src)).toEqual([]);
    expect(src).toMatch(/'local-e2e \(chrome\)'/);
    expect(src).toMatch(/runs-on: warp-ubuntu-latest-x64-8x/);
    expect(src).toMatch(/MIDEN_NODE_BLOCK_INTERVAL: 500ms/);
  });

  it('coverage is sharded and gated under the required check name', () => {
    const src = configSource('.github/workflows/pr.yml');
    expect(src).toMatch(/shard: \[1, 2, 3\]/);
    expect(src).toMatch(/name: Coverage Check \(95% minimum\)/);
    expect(src).toMatch(/merge-jest-coverage\.mjs/);
  });
});

/** The `run: |` body of the step that follows `anchor` (a job or step name line), with its original indentation kept. */
const runBlockAfter = (file: string, anchor: string): string => {
  const lines = configSource(file).split('\n');
  const start = lines.findIndex(line => line.trim() === anchor);
  // A missing anchor (start === -1) would otherwise make `i > start` true for every
  // line, silently matching the file's first run: | block instead of failing loudly.
  if (start === -1) throw new Error(`no anchor ${JSON.stringify(anchor)} found in ${file}`);
  const runAt = lines.findIndex((line, i) => i > start && /^\s*(- )?run: \|$/.test(line));
  const runLine = lines[runAt];
  // noUncheckedIndexedAccess: findIndex's -1-not-found case reads as undefined here too.
  if (runLine === undefined) throw new Error(`no run: | found after ${anchor} in ${file}`);
  const indent = runLine.search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body.join('\n');
};

/** The `on:` block (event triggers), by indentation, as a single string. */
const onBlock = (file: string): string => {
  const lines = configSource(file).split('\n');
  const start = lines.findIndex(line => line === 'on:');
  if (start === -1) throw new Error(`no on: block found in ${file}`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= 0) break;
    body.push(line);
  }
  return body.join('\n');
};

/** The job-level `if:` line's value for the job that starts at `anchor` (a `key:` line). */
const jobIfAfter = (file: string, anchor: string): string => {
  const lines = configSource(file).split('\n');
  const start = lines.findIndex(line => line.trim() === anchor);
  if (start === -1) throw new Error(`no anchor ${JSON.stringify(anchor)} found in ${file}`);
  const ifAt = lines.findIndex((line, i) => i > start && /^\s*if:\s/.test(line));
  const ifLine = lines[ifAt];
  if (ifLine === undefined) throw new Error(`no if: found after ${anchor} in ${file}`);
  return ifLine.trim().replace(/^if:\s*/, '');
};

/**
 * Runs a gate's shell with `values` supplied as env vars, the way a step's own `env:`
 * block would. Any `${{ ... }}` GitHub Actions expression still left in the script text
 * (a gate that has not moved its data through `env:`) is filled from `values` too, so
 * every such expression must have a matching value or this throws.
 */
const gateExit = (script: string, values: Record<string, string>): number | null => {
  const filled = script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const value = values[expr];
    if (value === undefined) throw new Error(`no value for ${expr}`);
    return value;
  });
  return spawnSync('bash', ['-eo', 'pipefail', '-c', filled], {
    stdio: 'pipe',
    env: { ...process.env, ...values }
  }).status;
};

const REQUIRED_NAMES = ['local-e2e (chrome)', 'guardian-lifecycle-e2e-gate', 'bridge-guardian-e2e-gate'];

/**
 * The exact condition every stacked-name decision must read. Pinned literally (not just
 * compared for consistency between two jobs) so a mutation that keeps Local and Bridge
 * agreeing with EACH OTHER on a wrong or widened condition -- or that only ever touches
 * one workflow -- still fails: e.g. Guardian's gate accepting any non-empty base.ref, or
 * dropping `next` from Local's name AND its if: together.
 */
const FULL =
  "github.event_name != 'pull_request' || github.event.pull_request.base.ref == 'main' || github.event.pull_request.base.ref == 'next'";

/** Every `.yml`/`.yaml` file directly under `.github/workflows`, repo-root-relative. */
const allWorkflowFiles = (): string[] =>
  readdirSync(resolve(repoRoot, '.github/workflows'))
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => `.github/workflows/${name}`)
    .sort();

const isContent = (line: string): boolean => line.trim() !== '' && !line.trimStart().startsWith('#');
const indentOf = (line: string): number => line.search(/\S/);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A scalar read exactly: a quoted string closed on its line with no escapes, or a one-line
 * plain scalar that starts with no YAML indicator and holds no `: `. Anything else (empty,
 * a block scalar, an alias, an anchor, a tag, a flow collection) throws.
 */
const readScalar = (raw: string): string => {
  const value = raw.trim();
  const quoted = /^'([^']*)'\s*(?:#.*)?$/.exec(value) ?? /^"([^"\\]*)"\s*(?:#.*)?$/.exec(value);
  if (quoted) return quoted[1]!;
  const plain = /^[^\s\-?:,[\]{}#&*!|>'"%@`].*?(?=\s+#|$)/.exec(value)?.[0];
  if (plain === undefined || /:(\s|$)/.test(plain)) throw new Error(`unreadable scalar ${JSON.stringify(raw)}`);
  return plain;
};

type MappingEntry = { key: string; value: string; block: string[] };

/**
 * The entries of a block mapping whose keys sit at `indent`: a plain `key:`, the rest of its
 * line, and the deeper content lines under it. Any other content line, or a repeated key, throws.
 */
const readMapping = (lines: string[], indent: number): MappingEntry[] => {
  const entries: MappingEntry[] = [];
  for (const line of lines.filter(isContent)) {
    const last = entries[entries.length - 1];
    if (last && indentOf(line) > indent) {
      last.block.push(line);
      continue;
    }
    const match = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):(?:\\s+(.*))?$`).exec(line);
    if (!match) throw new Error(`unreadable line at indent ${indent}: ${JSON.stringify(line)}`);
    if (entries.some(entry => entry.key === match[1])) throw new Error(`repeated key ${match[1]} at indent ${indent}`);
    entries.push({ key: match[1]!, value: (match[2] ?? '').trim(), block: [] });
  }
  return entries;
};

type ParsedJob = { jobId: string; rawName: string | null; matrix: { combos: string[] | null } | null };

/**
 * Whether a readMapping value is empty as YAML reads it: nothing, or only a comment, since
 * readMapping's capture starts after whitespace and so a leading `#` opens one.
 */
const isEmptyValue = (value: string): boolean => value === '' || value.startsWith('#');

/**
 * An axis's values when it is a bare one-line `[...]` list or a block sequence of one-line
 * scalars under an empty value (a comment alone counts as empty), else null: content and a
 * trailing comment, an anchor, tag or alias on its line, a flow list continued on the next
 * line, no items, or an item that is a mapping, spans lines or is no readable scalar.
 */
const axisValues = ({ value, block }: MappingEntry): string[] | null => {
  const flow = /^\[([^\]]*)\]$/.exec(value);
  let items: Array<string | undefined> = [];
  if (flow && block.length === 0) items = flow[1]!.split(',');
  else if (isEmptyValue(value)) items = block.map(line => /^\s+- (.*)$/.exec(line)?.[1]);
  if (items.length === 0 || items.includes(undefined)) return null;
  try {
    return items.map(item => readScalar(item!));
  } catch {
    return null;
  }
};

/**
 * A job's matrix: none, or `combos: null` for one it cannot enumerate (inline strategy content,
 * an include, an exclude, any `${{ }}`, or an axis axisValues cannot read), which a job's name
 * then takes as any suffix, else every combination of its axes. A strategy or matrix value that
 * is only a comment counts as empty, as YAML reads it. Only a strategy or matrix block line
 * readMapping cannot read throws.
 */
const readMatrix = (strategy: MappingEntry): ParsedJob['matrix'] => {
  if (!isEmptyValue(strategy.value)) return { combos: null };
  const matrix = readMapping(strategy.block, 6).find(entry => entry.key === 'matrix');
  if (!matrix) return null;
  if (!isEmptyValue(matrix.value) || matrix.block.some(line => line.includes('${{'))) return { combos: null };
  const axes = readMapping(matrix.block, 8);
  if (axes.some(axis => axis.key === 'include' || axis.key === 'exclude')) return { combos: null };
  const values = axes.map(axisValues);
  if (!values.every((axis): axis is string[] => axis !== null)) return { combos: null };
  return {
    combos: values.reduce<string[]>(
      (combos, axis) => combos.flatMap(c => axis.map(v => (c === '' ? v : `${c}, ${v}`))),
      ['']
    )
  };
};

/**
 * Every job under a workflow's `jobs:` key, read from its text. Only the plain shape every
 * workflow here uses is read: one bare `jobs:` line, each job id alone on its indent-2 line,
 * job keys at indent 4, a one-line `name:` scalar, and a `strategy:` whose matrix it reads as
 * any suffix where it cannot enumerate it (readMatrix). Anything else throws, since a shape
 * this cannot read could hide a required name. No YAML parser is a direct dependency, so this
 * reads text.
 */
const parseJobs = (text: string): ParsedJob[] => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const jobsLines = lines.filter(line => /^jobs\s*:/.test(line));
  if (jobsLines.length !== 1 || jobsLines[0] !== 'jobs:') {
    throw new Error(`expected one bare jobs: line, found ${JSON.stringify(jobsLines)}`);
  }
  const jobsAt = lines.indexOf('jobs:');
  // A column-0 comment does not end a YAML mapping; only a column-0 key does.
  const sectionEnd = lines.findIndex((line, i) => i > jobsAt && /^[^\s#]/.test(line));
  const section = lines.slice(jobsAt + 1, sectionEnd === -1 ? undefined : sectionEnd);
  return readMapping(section, 2).map(({ key: jobId, value, block }) => {
    if (value !== '') throw new Error(`job id ${jobId} is not alone on its line`);
    const entries = readMapping(block, 4);
    const name = entries.find(entry => entry.key === 'name');
    if (name && name.block.length > 0) throw new Error(`job ${jobId}'s name continues past its line`);
    const strategy = entries.find(entry => entry.key === 'strategy');
    return { jobId, rawName: name ? readScalar(name.value) : null, matrix: strategy ? readMatrix(strategy) : null };
  });
};

/**
 * The pattern source of every text `name` could render to. Everything from its first `${{`
 * to its last `}}` is one wildcard, so no expression is read as literal text and a `}}`
 * inside a string literal cannot end one early.
 */
const wildcardFromName = (name: string): string => {
  const open = name.indexOf('${{');
  if (open === -1) return escapeRegExp(name);
  const close = name.lastIndexOf('}}');
  return `${escapeRegExp(name.slice(0, open))}.*${close > open ? escapeRegExp(name.slice(close + 2)) : ''}`;
};

const LOCAL = '.github/workflows/pr-e2e-local.yml';
const GUARDIAN = '.github/workflows/pr-e2e-guardian-lifecycle.yml';
const BRIDGE = '.github/workflows/pr-e2e-bridge-guardian.yml';

/** The one job in each E2E workflow that may compute its name from FULL, and the required name it computes. */
const FULL_NAME_JOBS = [
  { file: LOCAL, jobId: 'chrome-local', name: 'local-e2e (chrome)' },
  { file: GUARDIAN, jobId: 'guardian-lifecycle-e2e-gate', name: 'guardian-lifecycle-e2e-gate' },
  { file: BRIDGE, jobId: 'bridge-guardian-e2e-gate', name: 'bridge-guardian-e2e-gate' }
];

/** The one safe shape: `${{ (FULL) && '<required>' || '<required> (stacked)' }}`, FULL exactly the constant. */
const TERNARY_NAME = /^\$\{\{\s*\(([\s\S]+?)\)\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}$/;

/**
 * The reason and remedy each violation's text starts with, before where it is. defaultToken and
 * plainShape are remedies alone, each following the reason its violation or error states first.
 */
const REMEDY = {
  jobName:
    'a job would report a required E2E check name outside the designated FULL-ternary form, so rename the job or use the FULL ternary on its designated job',
  designatedStrategy:
    'the designated job carries a strategy the checker reads as a matrix, whose combination suffix would change its reported name, so remove the matrix, or write `strategy:` as block lines with no `matrix:` key',
  plainShape:
    'so write the job in the plain shape: one bare jobs: line, 2-space job ids, 4-space keys, sequence items indented deeper than their key (for example `steps:` items at 6 spaces), each key plain, unquoted and written once, with no merge key or anchor, and a one-line name: scalar',
  requiredName:
    "a required E2E check name outside its designated job's `name:` line, gate id line or `needs:` entry, so remove it, or in a YAML or shell file move it to a `#` comment line",
  lineBreakCr:
    'a bare CR, which YAML reads as a line break and these rules do not, so save the file with LF line endings',
  lineBreakInvisible:
    'an invisible line break character, which YAML reads as a line break and these rules do not, so delete the invisible character on that line',
  defaultToken: 'so add a top-level `permissions:` block, for example `contents: read`',
  apiWrite:
    'the line writes or grants the Checks or Statuses API, which only an API_WRITER_ALLOWLIST file may do, so remove the call or grant, or have a person confirm the file never reports a required name and pin it in API_WRITER_ALLOWLIST',
  quotedKey:
    'a quoted mapping key, which these rules do not read, so write the key unquoted, and put script content in a `run: |` or `script: |` block',
  permissionsWord:
    '`permissions` may appear in a workflow only as a plain `permissions:` key or inside a block scalar body such as `run: |`, and a one-line `run:` is a plain scalar, not a body, so reword the mention, move it to a comment line, or write the `run:` as a `run: |` block',
  permissionsShape:
    'a permissions value or block line outside the allowlist, so write `permissions:` as block lines `scope: read|write|none`, with checks and statuses only read or none, and no quotes, flow form, anchors, tags or merge keys'
};

type NameViolation = { file: string; jobId: string; name: string; text: string };

/** The FULL_NAME_JOBS entry for `job`'s file and job id when its name is exactly that entry's FULL ternary, whatever its strategy. */
const designatedEntryOf = (file: string, job: ParsedJob): (typeof FULL_NAME_JOBS)[number] | undefined => {
  const designated = FULL_NAME_JOBS.find(entry => entry.file === file && entry.jobId === job.jobId);
  const ternary = TERNARY_NAME.exec(job.rawName ?? '');
  const matches =
    designated !== undefined &&
    ternary !== null &&
    ternary[1]!.trim() === FULL &&
    ternary[2] === designated.name &&
    ternary[3] === `${designated.name} (stacked)`;
  return matches ? designated : undefined;
};

/** Whether `job` is its workflow's designated job, named exactly the FULL ternary of its own required name, with no matrix. */
const isDesignatedFullName = (file: string, job: ParsedJob): boolean =>
  job.matrix === null && designatedEntryOf(file, job) !== undefined;

/**
 * Every required name one job could report other than as its designated FULL name. A
 * designated job whose only defect is its strategy is one violation under its own required
 * name with REMEDY.designatedStrategy. Every other job is checked against every required
 * name its name, with or without the suffix, could render: GitHub leaves a matrix job's
 * combination suffix off a name that references the matrix, which an expression may or may
 * not do.
 */
const jobViolations = (file: string, job: ParsedJob, required: string[]): NameViolation[] => {
  if (isDesignatedFullName(file, job)) return [];
  const designated = designatedEntryOf(file, job);
  if (designated) {
    return [{ file, jobId: job.jobId, name: designated.name, text: `${REMEDY.designatedStrategy}: jobs.${job.jobId}` }];
  }
  const combos = job.matrix?.combos?.map(escapeRegExp).join('|') ?? '.*';
  const suffix = job.matrix ? `(?: \\((?:${combos})\\))?` : '';
  const pattern = new RegExp(`^${wildcardFromName(job.rawName ?? job.jobId)}${suffix}$`);
  return required
    .filter(name => pattern.test(name))
    .map(name => ({ file, jobId: job.jobId, name, text: `${REMEDY.jobName}: jobs.${job.jobId}` }));
};

/** The jobs of one workflow file, or an error naming the file, what parseJobs could not read and the shape it reads. */
const jobsOf = (file: string, text: string): ParsedJob[] => {
  try {
    return parseJobs(text);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}, ${REMEDY.plainShape}`);
  }
};

/** The ids of the jobs jobsOf reads with a matrix, whether or not readMatrix can enumerate it. */
const matrixJobIds = (file: string, text: string): string[] =>
  jobsOf(file, text)
    .filter(job => job.matrix !== null)
    .map(job => job.jobId);

/** Every C-06 violation in one workflow file's text, taking (file, text) so the real tree and synthetic cases share this one code path. */
const workflowViolations = (file: string, text: string): NameViolation[] =>
  jobsOf(file, text).flatMap(job => jobViolations(file, job, REQUIRED_NAMES));

/** This file, which names every required name and API pattern in order to test the rules below. */
const THIS_FILE = relative(repoRoot, __filename);

/** Whether a file's first 8 KB holds a NUL byte, the mark of a binary. */
const looksBinary = (file: string): boolean => {
  const fd = openSync(resolve(repoRoot, file), 'r');
  try {
    const head = new Uint8Array(8192);
    return head.subarray(0, readSync(fd, head, 0, head.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
};

/**
 * The listed paths CI can run: all but docs, Markdown, the lockfile, this file and binaries. A
 * tracked symlink to a directory is skipped, since the files under it are tracked themselves,
 * and so is a path deleted from the worktree but not yet from the index.
 */
const ciSourceFilter = (paths: string[]): string[] =>
  paths
    .filter(
      file =>
        file !== '' && !file.startsWith('docs/') && !file.endsWith('.md') && file !== 'yarn.lock' && file !== THIS_FILE
    )
    .filter(
      file => statSync(resolve(repoRoot, file), { throwIfNoEntry: false })?.isFile() === true && !looksBinary(file)
    );

/** Every tracked file CI can run. */
const ciSourceFiles = (): string[] => {
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed (signal ${listed.signal}, error ${listed.error?.message}): ${listed.stderr}`);
  }
  return ciSourceFilter(listed.stdout.split('\0'));
};

/** The entries of a one-line `needs:` value, a single id or a flow list, or none for any other line. */
const needsEntries = (line: string): string[] => {
  const value = /^\s*needs:\s*(.*?)\s*$/.exec(line)?.[1];
  if (value === undefined) return [];
  const list = /^\[(.*)\]$/.exec(value)?.[1];
  return list === undefined ? [value] : list.split(',').map(entry => entry.trim());
};

/** The index of a job's own id line and of the indent-4 `name:` line in its block, each -1 when absent. */
const jobLines = (lines: string[], jobId: string): { idAt: number; nameAt: number } => {
  const idAt = lines.indexOf(`  ${jobId}:`);
  if (idAt === -1) return { idAt, nameAt: -1 };
  const end = lines.findIndex((line, i) => i > idAt && isContent(line) && indentOf(line) <= 2);
  const nameAt = lines.findIndex((line, i) => i > idAt && (end === -1 || i < end) && /^ {4}name:/.test(line));
  return { idAt, nameAt };
};

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_PATH = /^\.github\/actions\/[^/]+\/action\.ya?ml$/;
/** A line break YAML reads and the rules' split on LF or CRLF does not. */
const NON_LF_BREAK = /\r(?!\n)|[\u2028\u2029\u0085]/;

/** One offending line, or line 0 for a violation of the whole file, and what to do about it. */
type Violation = { file: string; line: number; text: string };

/**
 * A workflow or composite action holding NON_LF_BREAK, as one violation of the whole file, since
 * the rules would not read the lines YAML does. Its text names the first break's code point and
 * its line, counted in LFs.
 */
const lineBreakViolations = (file: string, text: string): Violation[] => {
  const found = WORKFLOW_PATH.test(file) || ACTION_PATH.test(file) ? NON_LF_BREAK.exec(text) : null;
  if (found === null) return [];
  const codePoint = `U+${found[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  const line = text.slice(0, found.index).split('\n').length;
  const remedy = found[0] === '\r' ? REMEDY.lineBreakCr : REMEDY.lineBreakInvisible;
  return [{ file, line: 0, text: `${remedy}: ${codePoint} on line ${line}` }];
};

type LiteralViolation = { file: string; line: number; name: string; text: string };

/**
 * Every content line naming a required name anywhere but where its designated job reports it,
 * each violation's text naming its reason and remedy and then the trimmed line. Allowed are
 * that job's own `name:` line and, for a gate, its own id line or a `needs:` entry naming it,
 * all in its designated file. It reads every line of every file CI can run, allowlisted API
 * writers included, whatever carries the name: a job name, a check-run or status payload, an
 * action input or a script. A name computed at run time is left to the API rule. A workflow or
 * composite action breaking a line other than at LF or CRLF is refused whole before any line is read.
 */
const requiredNameLiteralViolations = (file: string, text: string): Array<LiteralViolation | Violation> => {
  const refused = lineBreakViolations(file, text);
  if (refused.length > 0) return refused;
  const lines = text.split(/\r?\n/);
  const allowed = (name: string, at: number): boolean =>
    FULL_NAME_JOBS.some(job => {
      if (job.name !== name || job.file !== file) return false;
      const isGate = job.jobId === name;
      if (isGate && needsEntries(lines[at]!).includes(name)) return true;
      const { idAt, nameAt } = jobLines(lines, job.jobId);
      return at === nameAt || (isGate && at === idAt);
    });
  return lines.flatMap((line, at) =>
    isContent(line)
      ? REQUIRED_NAMES.filter(name => line.includes(name) && !allowed(name, at)).map(name => ({
          file,
          line: at + 1,
          name,
          text: `${REMEDY.requiredName}: ${line.trim()}`
        }))
      : []
  );
};

/**
 * The only files that may write the Checks or Statuses API, each pinned to the SHA-256 of its
 * whole text. A file joins this list, or its pin changes, only after a human confirms it never
 * reports a required E2E name.
 */
const API_WRITER_ALLOWLIST = [
  {
    file: '.github/workflows/check-linked-web-sdk-pr.yml',
    sha256: '6d473729f44a96453884085bdb26d0bfdf28ae5d7bb49200fa0bc42f53023c7d'
  }
];

const API_WRITE =
  /check-runs|\/statuses\b|checks\.(create|update)|createCommitStatus|\b(create|update)CheckRun\b|\bwrite-all\b|\b(checks|statuses)["']?\s*:\s*["']?write\b/;

/** A plain `permissions` key at any indent, and the rest of its line. */
const PERMISSIONS_KEY = /^\s*permissions\s*:(.*)$/;
const PERMISSIONS_VALUE = /^\s*(\{\}|read-all)?\s*(#.*)?$/;
const PERMISSION_SCOPE = /^\s+([a-z][a-z-]*):\s*(read|write|none)\s*(#.*)?$/;
/** A line whose first token is a quoted mapping key, which may spell `permissions` with an escape. */
const QUOTED_KEY = /^\s*(-\s+)?["'][^"']*["']\s*:/;
/** A `key:` or `- key:` line whose value is a block scalar header; group 1's width is the key token's column. */
const BLOCK_SCALAR_KEY = /^(\s*(?:-\s+)?)[A-Za-z0-9_.-]+:\s+[|>][+-]?[0-9]?(?:\s+#.*)?\s*$/;

/**
 * The index of every line in a block scalar body, which YAML reads as text rather than keys. A
 * body ends at the first non-blank line at or left of its key token's column, so a sibling key
 * of a `- run: |` step, level with `run`, ends it.
 */
const blockScalarLines = (lines: string[]): Set<number> => {
  const body = new Set<number>();
  let keyColumn = -1;
  lines.forEach((line, at) => {
    if (keyColumn !== -1 && (line.trim() === '' || indentOf(line) > keyColumn)) {
      body.add(at);
      return;
    }
    keyColumn = BLOCK_SCALAR_KEY.exec(line)?.[1]!.length ?? -1;
  });
  return body;
};

/** The index of every line on or under a plain `permissions` key that its allowlist does not name. */
const unlistedPermissionLines = (lines: string[]): Set<number> => {
  const unlisted = new Set<number>();
  lines.forEach((line, at) => {
    const key = PERMISSIONS_KEY.exec(line);
    if (!key) return;
    if (!PERMISSIONS_VALUE.test(key[1]!)) unlisted.add(at);
    const end = lines.findIndex((next, i) => i > at && isContent(next) && indentOf(next) <= indentOf(line));
    for (let i = at + 1; i < (end === -1 ? lines.length : end); i++) {
      const scope = PERMISSION_SCOPE.exec(lines[i]!);
      const grantsWrite = scope !== null && scope[2] === 'write' && /^(checks|statuses)$/.test(scope[1]!);
      if (isContent(lines[i]!) && (scope === null || grantsWrite)) unlisted.add(i);
    }
  });
  return unlisted;
};

/**
 * Every way a file could write the Checks or Statuses API with the workflow token, each
 * violation's text naming its reason and remedy (REMEDY) and then the trimmed line. A workflow
 * or composite action breaking a line other than at LF or CRLF is refused whole before any line
 * rule. In any file, a content line calling either REST API or the GraphQL check-run mutations,
 * or granting that write (`checks` or `statuses` set to `write` in any quoting, spacing or flow
 * form, or `write-all`), is flagged. A workflow is read only in the plain shape these rules
 * model, so it is also flagged for: no top-level `permissions:` block, whose token takes the
 * repository's default permissions; a content line whose first token is a quoted mapping key;
 * a content line holding the word `permissions` other than as a plain `permissions:` key at any
 * indent, such as behind a tag, anchor, alias, explicit `?` key, quote or merge key, inside a
 * flow mapping, or in a one-line `run:` value, which is a plain scalar; and a `permissions:`
 * value other than empty, `{}` or `read-all`, or a content line in the block under it other than
 * a plain `scope: read|write|none` with `checks` and `statuses` only `read` or `none`. Those
 * three key-shape rules exempt a block scalar body (the lines after a `key: |` or `key: >` line,
 * up to the first non-blank line at or left of the key's column), which YAML reads as text,
 * while still reading its `key:` line, so a `permissions: |` is flagged. An allowlisted file is
 * exempt only while its text hashes to its pin, so any edit to it, on whichever line, is one
 * violation for the whole file.
 *
 * These rules guard against a workflow reporting a required name by accident, in the plain YAML
 * style every workflow here uses, and they refuse every shape a person writes by accident.
 * Deliberately encoded YAML, such as a tag, anchor, explicit key or flow mapping wrapped around
 * an escaped key, is out of scope: its author could edit this test as easily, and parseJobs
 * already throws on such shapes at job level. The one reporting path outside every rule is an
 * action given a PAT or App token from a secret, whose checks scope is granted outside the
 * repository; the guard for that one is the ruleset pinning each required check's source to
 * GitHub Actions.
 */
const apiWriterViolations = (file: string, text: string): Violation[] => {
  const refused = lineBreakViolations(file, text);
  if (refused.length > 0) return refused;
  const pinned = API_WRITER_ALLOWLIST.find(entry => entry.file === file);
  if (pinned) {
    return createHash('sha256').update(text).digest('hex') === pinned.sha256
      ? []
      : [
          {
            file,
            line: 0,
            text: `changed since it was allowlisted: confirm it reports no required E2E name, then update its pinned sha256 in ${THIS_FILE}`
          }
        ];
  }
  const lines = text.split(/\r?\n/);
  const workflow = WORKFLOW_PATH.test(file);
  const defaultToken: Violation[] =
    workflow && !lines.some(line => line.startsWith('permissions:'))
      ? [
          {
            file,
            line: 0,
            text: `no top-level permissions: block, which leaves the token the repository default permissions, ${REMEDY.defaultToken}`
          }
        ]
      : [];
  const unlisted = workflow ? unlistedPermissionLines(lines) : new Set<number>();
  const scalarBody = workflow ? blockScalarLines(lines) : new Set<number>();
  const remedyFor = (line: string, at: number): string | null => {
    if (!isContent(line)) return null;
    if (API_WRITE.test(line)) return REMEDY.apiWrite;
    // The key-shape rules below skip block scalar bodies; API_WRITE does not, as `gh api` calls live in them.
    if (!workflow || scalarBody.has(at)) return null;
    if (QUOTED_KEY.test(line)) return REMEDY.quotedKey;
    if (/\bpermissions\b/.test(line) && !PERMISSIONS_KEY.test(line)) return REMEDY.permissionsWord;
    return unlisted.has(at) ? REMEDY.permissionsShape : null;
  };
  return [
    ...defaultToken,
    ...lines.flatMap((line, at) => {
      const remedy = remedyFor(line, at);
      return remedy === null ? [] : [{ file, line: at + 1, text: `${remedy}: ${line.trim()}` }];
    })
  ];
};

describe('a stacked pull request reports its E2E checks under names no branch requires', () => {
  it.each(FULL_NAME_JOBS)('the designated $jobId job in $file computes its required name from FULL', entry => {
    const job = jobsOf(entry.file, configSource(entry.file)).find(({ jobId }) => jobId === entry.jobId);
    expect(job).toBeDefined();
    expect(isDesignatedFullName(entry.file, job!)).toBe(true);
  });

  it('every required name has a designated job', () => {
    expect(FULL_NAME_JOBS.map(({ name }) => name)).toEqual(REQUIRED_NAMES);
  });

  it('a commented-out FULL name above a plain name leaves the Guardian gate undesignated', () => {
    // The raw text still holds the FULL ternary, in the comment; only the parser reads the live name.
    const lines = configSource(GUARDIAN).split('\n');
    const at = lines.indexOf('  guardian-lifecycle-e2e-gate:') + 1;
    expect(lines[at]).toMatch(/^ {4}name: /);
    lines.splice(at, 1, `    # ${lines[at]!.trim()}`, '    name: Guardian gate');
    const gate = jobsOf(GUARDIAN, lines.join('\n')).find(({ jobId }) => jobId === 'guardian-lifecycle-e2e-gate');
    expect(gate).toBeDefined();
    expect(isDesignatedFullName(GUARDIAN, gate!)).toBe(false);
  });

  it("chrome-local's if: matches the FULL condition inside its own computed name", () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    const ifMatch = /\n\s+if: \$\{\{ (github\.event_name[\s\S]+?) \}\}\n/.exec(src);
    expect(ifMatch).not.toBeNull();
    expect(ifMatch![1]!.trim()).toBe(FULL);
  });

  it("bridge-guardian-e2e's if: matches the FULL condition inside its gate's computed name", () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    const ifMatch = /\n\s+if: (github\.event_name[\s\S]+?)\n/.exec(src);
    expect(ifMatch).not.toBeNull();
    expect(ifMatch![1]!.trim()).toBe(FULL);
  });
});

/** What the checker does with one workflow's text. */
const checkerOutcome = (file: string, text: string): 'flags' | 'throws' | 'passes' => {
  try {
    return workflowViolations(file, text).length > 0 ? 'flags' : 'passes';
  } catch {
    return 'throws';
  }
};

const fullNameOf = (name: string): string => `\${{ (${FULL}) && '${name}' || '${name} (stacked)' }}`;

const MERGE_KEY: [file: string, text: string] = [
  'synthetic-merge-key.yml',
  'jobs:\n  base:\n    runs-on: ubuntu-latest\n    env: &gate\n      name: bridge-guardian-e2e-gate\n  some-job:\n    <<: *gate\n    runs-on: ubuntu-latest\n'
];
const TWO_NAMES: [file: string, text: string] = [
  'synthetic-two-names.yml',
  'jobs:\n  some-job:\n    name: some-job\n    name: bridge-guardian-e2e-gate\n    runs-on: ubuntu-latest\n'
];

/**
 * Each case is a title, what the checker must do, a workflow file name and its full text.
 * A case under one of the three E2E workflows' names exercises the one exemption, which
 * only the designated job there can earn.
 */
const nameViolationCases: Array<[string, 'flags' | 'throws', string, string]> = [
  [
    'a quoted literal equal to a required name',
    'flags',
    'synthetic-quoted.yml',
    "jobs:\n  some-job:\n    name: 'local-e2e (chrome)'\n    runs-on: ubuntu-latest\n"
  ],
  [
    'a required name with a trailing comment',
    'flags',
    'synthetic-commented.yml',
    'jobs:\n  some-job:\n    name: bridge-guardian-e2e-gate # x\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a required name terminated by CRLF',
    'flags',
    'synthetic-crlf.yml',
    'jobs:\r\n  some-job:\r\n    name: bridge-guardian-e2e-gate\r\n    runs-on: ubuntu-latest\r\n'
  ],
  [
    'a guardian-lifecycle-e2e-gate job with no name, reporting via its job id',
    'flags',
    'synthetic-jobid-a.yml',
    'jobs:\n  guardian-lifecycle-e2e-gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'
  ],
  [
    'a bridge-guardian-e2e-gate job with no name, reporting via its job id',
    'flags',
    'synthetic-jobid-b.yml',
    'jobs:\n  bridge-guardian-e2e-gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'
  ],
  [
    'a local-e2e job with a browser matrix and no name',
    'flags',
    'synthetic-matrix-id.yml',
    'jobs:\n  local-e2e:\n    strategy:\n      matrix:\n        browser: [chrome]\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a name that interpolates matrix.browser',
    'flags',
    'synthetic-matrix-name.yml',
    `jobs:\n  some-job:\n    name: local-e2e (\${{ matrix.browser }})\n    strategy:\n      matrix:\n        browser: [chrome]\n    runs-on: ubuntu-latest\n`
  ],
  [
    'a computed name under a condition other than FULL, in a fourth file',
    'flags',
    'synthetic-wrong-condition.yml',
    `jobs:\n  some-job:\n    name: \${{ (github.event_name == 'pull_request') && 'local-e2e (chrome)' || 'local-e2e (chrome) (stacked)' }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'a FULL ternary with a required name in its false branch',
    'flags',
    'synthetic-false-branch.yml',
    `jobs:\n  some-job:\n    name: \${{ (${FULL}) && 'bridge-guardian-e2e-gate (stacked)' || 'bridge-guardian-e2e-gate' }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'the designated Bridge gate with another required name in its false branch',
    'flags',
    BRIDGE,
    `jobs:\n  bridge-guardian-e2e-gate:\n    name: \${{ (${FULL}) && 'bridge-guardian-e2e-gate' || 'local-e2e (chrome)' }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'the designated Local job under a condition other than FULL',
    'flags',
    LOCAL,
    `jobs:\n  chrome-local:\n    name: \${{ (github.event_name == 'pull_request') && 'local-e2e (chrome)' || 'local-e2e (chrome) (stacked)' }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'the designated Local job computing another required name',
    'flags',
    LOCAL,
    `jobs:\n  chrome-local:\n    name: ${fullNameOf('bridge-guardian-e2e-gate')}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'an unparenthesised && and || name on the designated Guardian gate',
    'flags',
    GUARDIAN,
    `jobs:\n  guardian-lifecycle-e2e-gate:\n    name: \${{ ${FULL} && 'guardian-lifecycle-e2e-gate' || 'guardian-lifecycle-e2e-gate (stacked)' }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    `\${{ 'guardian-lifecycle-e2e-gate' }} on the designated Guardian gate`,
    'flags',
    GUARDIAN,
    `jobs:\n  guardian-lifecycle-e2e-gate:\n    name: \${{ 'guardian-lifecycle-e2e-gate' }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    `local-e2e (\${{ 'chrome' }})`,
    'flags',
    'synthetic-mixed-a.yml',
    `jobs:\n  some-job:\n    name: local-e2e (\${{ 'chrome' }})\n    runs-on: ubuntu-latest\n`
  ],
  [
    `bridge-guardian-e2e-\${{ 'gate' }}`,
    'flags',
    'synthetic-mixed-b.yml',
    `jobs:\n  some-job:\n    name: bridge-guardian-e2e-\${{ 'gate' }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    `\${{ format('{0}-gate', 'bridge-guardian-e2e') }}`,
    'flags',
    'synthetic-format.yml',
    `jobs:\n  some-job:\n    name: \${{ format('{0}-gate', 'bridge-guardian-e2e') }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'an exact FULL-ternary local-e2e (chrome) job copied into a fourth file',
    'flags',
    'synthetic-copied-ternary.yml',
    `jobs:\n  chrome-local:\n    name: ${fullNameOf('local-e2e (chrome)')}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'an exact FULL-ternary local-e2e (chrome) job under another job id in the Local workflow',
    'flags',
    LOCAL,
    `jobs:\n  chrome-local-copy:\n    name: ${fullNameOf('local-e2e (chrome)')}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'the designated Local job carrying a matrix',
    'flags',
    LOCAL,
    `jobs:\n  chrome-local:\n    name: ${fullNameOf('local-e2e (chrome)')}\n    strategy:\n      matrix:\n        browser: [chrome]\n    runs-on: ubuntu-latest\n`
  ],
  [
    'a local-e2e job with a block-sequence browser matrix',
    'flags',
    'synthetic-block-matrix.yml',
    'jobs:\n  local-e2e:\n    strategy:\n      matrix:\n        browser:\n          - chrome\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a local-e2e job with an include-only matrix',
    'flags',
    'synthetic-include-matrix.yml',
    'jobs:\n  local-e2e:\n    strategy:\n      matrix:\n        include:\n          - browser: chrome\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a local-e2e job with a fromJSON matrix',
    'flags',
    'synthetic-fromjson-matrix.yml',
    `jobs:\n  local-e2e:\n    strategy:\n      matrix: \${{ fromJSON(needs.x.outputs.m) }}\n    runs-on: ubuntu-latest\n`
  ],
  [
    'a required-name job after a column-0 comment inside jobs:',
    'flags',
    'synthetic-column-0-comment.yml',
    'jobs:\n  some-job:\n    runs-on: ubuntu-latest\n# x\n  bridge-guardian-e2e-gate:\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a bridge-guardian-e2e-gate: # x job id with no name',
    'throws',
    'synthetic-commented-id.yml',
    'jobs:\n  some-job:\n    runs-on: ubuntu-latest\n  bridge-guardian-e2e-gate: # x\n    needs: some-job\n'
  ],
  [
    'jobs: # x followed by a bridge-guardian-e2e-gate job',
    'throws',
    'synthetic-commented-jobs.yml',
    'jobs: # x\n  bridge-guardian-e2e-gate:\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a jobs key written as jobs :',
    'throws',
    'synthetic-spaced-jobs.yml',
    'jobs :\n  bridge-guardian-e2e-gate:\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a four-space-indented bridge-guardian-e2e-gate job',
    'throws',
    'synthetic-four-space-id.yml',
    'jobs:\n    bridge-guardian-e2e-gate:\n      runs-on: ubuntu-latest\n'
  ],
  [
    'a job whose keys sit at indent 6',
    'throws',
    'synthetic-six-space-keys.yml',
    'jobs:\n  some-job:\n      name: bridge-guardian-e2e-gate\n      runs-on: ubuntu-latest\n'
  ],
  ['a job-level <<: merge key', 'throws', ...MERGE_KEY],
  ['a job with two name: keys', 'throws', ...TWO_NAMES],
  [
    "a name: value 'bridge-guardian-e2e-gate' on the next line",
    'throws',
    'synthetic-name-next-line.yml',
    'jobs:\n  some-job:\n    name:\n      bridge-guardian-e2e-gate\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a name: >- block scalar',
    'throws',
    'synthetic-name-folded.yml',
    'jobs:\n  some-job:\n    name: >-\n      bridge-guardian-e2e-gate\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a name: that is an alias',
    'throws',
    'synthetic-name-alias.yml',
    'jobs:\n  base:\n    runs-on: ubuntu-latest\n    env:\n      GATE: &gate bridge-guardian-e2e-gate\n  some-job:\n    name: *gate\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a plain name: value continued on the next line',
    'throws',
    'synthetic-name-continued.yml',
    'jobs:\n  some-job:\n    name: local-e2e\n      (chrome)\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a strategy: with inline content',
    'flags',
    'synthetic-inline-strategy.yml',
    'jobs:\n  local-e2e:\n    strategy: { matrix: { browser: [chrome] } }\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a matrix axis value it cannot read',
    'flags',
    'synthetic-tagged-axis.yml',
    'jobs:\n  local-e2e:\n    strategy:\n      matrix:\n        browser: [!!str chrome]\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a quoted matrix axis key',
    'throws',
    'synthetic-quoted-axis.yml',
    'jobs:\n  some-job:\n    strategy:\n      matrix:\n        "browser": [chrome]\n    runs-on: ubuntu-latest\n'
  ]
];

/** A workflow whose one job, `jobId`, has `strategy`, written at indent 0, among its keys. */
const jobWithStrategy = (jobId: string, strategy: string): string =>
  `jobs:\n  ${jobId}:\n${strategy.replace(/^/gm, '    ')}\n    runs-on: ubuntu-latest\n`;

/** Matrices the checker cannot enumerate, each a `strategy:` entry written at indent 0. */
const UNENUMERABLE_MATRICES: Array<[title: string, strategy: string]> = [
  ['an axis whose block item is - { os: a }', 'strategy:\n  matrix:\n    config:\n      - { os: a }'],
  ['an axis of block mappings', 'strategy:\n  matrix:\n    config:\n      - os: a\n        arch: x'],
  ['strategy: { matrix: { os: [a] } }', 'strategy: { matrix: { os: [a] } }'],
  ['browser: [chrome] # x', 'strategy:\n  matrix:\n    browser: [chrome] # x']
];

/**
 * Each unenumerable matrix, read as any combination suffix: it passes on some-job, which no
 * suffix makes a required name, and flags on local-e2e, which a suffix makes local-e2e (chrome).
 */
const matrixWildcardCases = UNENUMERABLE_MATRICES.flatMap(
  ([title, strategy]): Array<[string, 'passes' | 'flags', string]> => [
    [`a some-job with ${title}`, 'passes', jobWithStrategy('some-job', strategy)],
    [`a local-e2e job with ${title}`, 'flags', jobWithStrategy('local-e2e', strategy)]
  ]
);

/** Workflows parseJobs refuses, each with text its error must hold. */
const refusalMessageCases: Array<[title: string, message: string, file: string, text: string]> = [
  [
    'a job whose steps: items sit level with the key',
    'sequence items indented deeper than their key (for example `steps:` items at 6 spaces)',
    'synthetic-level-steps.yml',
    'jobs:\n  some-job:\n    runs-on: ubuntu-latest\n    steps:\n    - run: echo hi\n'
  ],
  ['a job with two name: keys', 'repeated key name at indent 4', ...TWO_NAMES],
  ['a job-level <<: merge key', 'with no merge key or anchor', ...MERGE_KEY]
];

const READ_ONLY = 'permissions:\n  contents: read\n';
const ONE_JOB = 'jobs:\n  some-job:\n    runs-on: ubuntu-latest\n';

/** A read-only workflow whose one job runs `step`, a steps-list item already indented and newline-terminated. */
const workflowWithStep = (step: string): string => `${READ_ONLY}${ONE_JOB}    steps:\n${step}`;

const CHECK_RUN_COMMAND =
  "gh api repos/$GITHUB_REPOSITORY/check-runs -f name='local-e2e (chrome)' -f head_sha=$SHA -f conclusion=success";

/** A case's text: a literal, or a function reading a live repository file when its own case runs. */
type SourceText = string | (() => string);
const sourceText = (text: SourceText): string => (typeof text === 'function' ? text() : text);

type SourceCase = [title: string, file: string, text: SourceText];

const L1: SourceCase = [
  'L1: a workflow step posting a check run',
  '.github/workflows/synthetic-check-run.yml',
  workflowWithStep(`      - run: ${CHECK_RUN_COMMAND}\n`)
];
const L5: SourceCase = [
  'L5: a script posting a status',
  'scripts/x.sh',
  `#!/usr/bin/env bash\ngh api "repos/$GITHUB_REPOSITORY/statuses/$SHA" -f state=success -f context='local-e2e (chrome)'\n`
];
const A1: SourceCase = [
  'A1: a workflow step posting a check run under a computed name',
  '.github/workflows/synthetic-computed-check-run.yml',
  workflowWithStep(
    `      - run: gh api repos/$GITHUB_REPOSITORY/check-runs -f name="local-e2e ($B)" -f head_sha=$SHA -f conclusion=success\n`
  )
];
/** YAML reads the bare CR as a line break, so the step after it runs; split on LF, it is part of the comment. */
const B1: SourceCase = [
  'B1: a composite action whose bare CR ends a comment before a check-run step',
  '.github/actions/x/action.yml',
  `name: x\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      # note\r      run: gh api repos/$R/check-runs -f name='local-e2e (chrome)'\n`
];

/**
 * Each case is a source file the literal rule must flag, with the required name it must flag
 * there, or 'the whole file' for a file it refuses whole at line 0.
 */
const requiredNameLiteralCases: Array<[...SourceCase, string]> = [
  [...L1, 'local-e2e (chrome)'],
  [
    'L2: a workflow step posting a status',
    '.github/workflows/synthetic-status.yml',
    workflowWithStep(
      '      - run: gh api repos/$GITHUB_REPOSITORY/statuses/$SHA -f state=success -f context=bridge-guardian-e2e-gate\n'
    ),
    'bridge-guardian-e2e-gate'
  ],
  [
    'L3: a github-script step calling checks.create',
    '.github/workflows/synthetic-github-script.yml',
    workflowWithStep(
      "      - uses: actions/github-script@v7\n        with:\n          script: |\n            await github.rest.checks.create({ name: 'guardian-lifecycle-e2e-gate' })\n"
    ),
    'guardian-lifecycle-e2e-gate'
  ],
  [
    "L4: L1's step inside a composite action",
    '.github/actions/x/action.yml',
    `name: x\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: ${CHECK_RUN_COMMAND}\n`,
    'local-e2e (chrome)'
  ],
  [...L5, 'local-e2e (chrome)'],
  [
    'L6: a local-stack script posting a check run',
    'playwright/e2e/local-stack/x.sh',
    `#!/usr/bin/env bash\n${CHECK_RUN_COMMAND}\n`,
    'local-e2e (chrome)'
  ],
  [
    'L7: the real Local workflow plus a second job named local-e2e (chrome)',
    LOCAL,
    () => `${configSource(LOCAL)}  other-job:\n    name: 'local-e2e (chrome)'\n    runs-on: ubuntu-latest\n`,
    'local-e2e (chrome)'
  ],
  [
    "N1: a job outside the gate's own file naming the gate in needs:",
    '.github/workflows/synthetic-needs-gate.yml',
    'permissions:\n  contents: read\njobs:\n  some-job:\n    needs: [bridge-guardian-e2e-gate]\n    runs-on: ubuntu-latest\n',
    'bridge-guardian-e2e-gate'
  ],
  [...B1, 'the whole file']
];

const GRANTS = [`checks: 'write'`, `statuses: "write"`, `"checks": write`, `checks : write`];

type Level = 'top-level' | 'job-level';
const LEVELS: Level[] = ['top-level', 'job-level'];

/** A workflow holding `entry`, written at indent 0, at its top level or in its one job under a read-only top level. */
const workflowWith = (level: Level, entry: string): string =>
  level === 'top-level' ? `${entry}\n${ONE_JOB}` : `${READ_ONLY}${ONE_JOB}${entry.replace(/^/gm, '    ')}\n`;

/** Checks or statuses grants no single-line `write` pattern reads, each a titled entry for workflowWith. */
const UNREADABLE_GRANTS: Array<[title: string, entry: string]> = [
  ['checks: with write on the next line', 'permissions:\n  checks:\n    write'],
  ['checks: &w write', 'permissions:\n  checks: &w write'],
  ['statuses: !!str write', 'permissions:\n  statuses: !!str write'],
  ['checks: *w aliasing an env: anchor &w write', 'env:\n  W: &w write\npermissions:\n  checks: *w'],
  ['checks: "\\u0077rite"', 'permissions:\n  checks: "\\u0077rite"'],
  ['permissions: "write\\x2dall"', 'permissions: "write\\x2dall"'],
  ['"\\x63hecks": write', 'permissions:\n  "\\x63hecks": write'],
  ['? checks / : write', 'permissions:\n  ? checks\n  : write'],
  ['"permissions": key over checks: "\\u0077rite"', '"permissions":\n  checks: "\\u0077rite"'],
  ['"\\x70ermissions": key over checks: "\\u0077rite"', '"\\x70ermissions":\n  checks: "\\u0077rite"'],
  ['!!str permissions: key over checks: "\\u0077rite"', '!!str permissions:\n  checks: "\\u0077rite"'],
  ['&p permissions: key over checks: "\\u0077rite"', '&p permissions:\n  checks: "\\u0077rite"'],
  ['? permissions / : key over checks: "\\u0077rite"', '? permissions\n:\n  checks: "\\u0077rite"']
];

/** Grants behind a line break YAML reads and a split on LF does not, each a titled entry for workflowWith. */
const LINE_BREAK_GRANTS: Array<[title: string, entry: string]> = [
  ['permissions: then a bare CR before checks: "\\u0077rite"', 'permissions:\r  checks: "\\u0077rite"'],
  ['permissions: then U+2028 before checks: "\\u0077rite"', 'permissions:\u2028  checks: "\\u0077rite"']
];

/** A workflow indented four spaces a level, read-only at its top level, with `entry` among its one job's keys at indent 8. */
const fourSpaceJobWith = (entry: string): string =>
  `permissions:\n    contents: read\njobs:\n    some-job:\n        runs-on: ubuntu-latest\n${entry.replace(/^/gm, '        ')}\n`;

/** Permissions entries that grant no checks or statuses write. */
const READABLE_GRANTS = ['permissions:\n  checks: read', 'permissions:\n  statuses: none', 'permissions: {}'];

const LINKED = '.github/workflows/check-linked-web-sdk-pr.yml';
const LINKED_POST = '              | gh api -X POST "repos/$GITHUB_REPOSITORY/check-runs" --input - >/dev/null\n';

/**
 * A case text: the real LINKED text, read when its case runs, with `from`, which must occur in
 * it exactly once, replaced by `to`.
 */
const linkedWith =
  (from: string, to: string): (() => string) =>
  () => {
    const text = configSource(LINKED);
    if (text.split(from).length !== 2) {
      throw new Error(
        `${LINKED} changed: re-review it, then update API_WRITER_ALLOWLIST's sha256 and this case's anchor ${JSON.stringify(from)}`
      );
    }
    return text.replace(from, () => to);
  };

/** Where the API rule must flag a case: at one of its lines, or at line 0 for the whole file. */
type ApiArm = 'a line' | 'the whole file';
type ApiCase = [...SourceCase, ApiArm];

/** Each case is a source file the API rule must flag, and where it must flag it. */
const apiWriterCases: ApiCase[] = [
  [...A1, 'a line'],
  [
    'A2: a workflow granting checks: write',
    '.github/workflows/synthetic-checks-write.yml',
    'permissions:\n  checks: write\njobs:\n  some-job:\n    runs-on: ubuntu-latest\n',
    'a line'
  ],
  [
    'A3: a top-level permissions: write-all',
    '.github/workflows/synthetic-write-all.yml',
    `permissions: write-all\n${ONE_JOB}`,
    'a line'
  ],
  [
    'A3: a job-level permissions: write-all',
    '.github/workflows/synthetic-write-all.yml',
    `${READ_ONLY}${ONE_JOB}    permissions: write-all\n`,
    'a line'
  ],
  [
    'A4: a step creating a check run through the GraphQL API',
    '.github/workflows/synthetic-graphql.yml',
    workflowWithStep(
      `      - run: gh api graphql -f query='mutation { createCheckRun(input: {name: "local-e2e ($B)"}) }'\n`
    ),
    'a line'
  ],
  [
    'A5: a workflow with no top-level permissions block',
    '.github/workflows/synthetic-default-token.yml',
    `on: push\n${ONE_JOB}`,
    'the whole file'
  ],
  ...GRANTS.flatMap((grant): ApiCase[] => [
    [
      `A6: a top-level ${grant}`,
      '.github/workflows/synthetic-grant.yml',
      `permissions:\n  ${grant}\n${ONE_JOB}`,
      'a line'
    ],
    [
      `A6: a job-level ${grant}`,
      '.github/workflows/synthetic-grant.yml',
      `${READ_ONLY}${ONE_JOB}    permissions:\n      ${grant}\n`,
      'a line'
    ]
  ]),
  [
    "A6: a top-level flow permissions: { checks: 'write' }",
    '.github/workflows/synthetic-grant.yml',
    `permissions: { checks: 'write' }\n${ONE_JOB}`,
    'a line'
  ],
  [
    "A6: a job-level flow permissions: { checks: 'write' }",
    '.github/workflows/synthetic-grant.yml',
    `${READ_ONLY}${ONE_JOB}    permissions: { checks: 'write' }\n`,
    'a line'
  ],
  ...UNREADABLE_GRANTS.flatMap(([title, entry]) =>
    LEVELS.map(
      (level): ApiCase => [
        `A7: a ${level} ${title}`,
        '.github/workflows/synthetic-grant.yml',
        workflowWith(level, entry),
        'a line'
      ]
    )
  ),
  [
    'A7: a job-level "permissions": key at indent 8 in a four-space workflow over checks: "\\u0077rite"',
    '.github/workflows/synthetic-grant.yml',
    fourSpaceJobWith('"permissions":\n    checks: "\\u0077rite"'),
    'a line'
  ],
  [
    'A7: a job-level "\\x70ermissions": key at indent 8 over checks: "\\u0077rite"',
    '.github/workflows/synthetic-grant.yml',
    fourSpaceJobWith('"\\x70ermissions":\n    checks: "\\u0077rite"'),
    'a line'
  ],
  ...LINE_BREAK_GRANTS.flatMap(([title, entry]) =>
    LEVELS.map(
      (level): ApiCase => [
        `A8: a ${level} ${title}`,
        '.github/workflows/synthetic-line-break.yml',
        workflowWith(level, entry),
        'the whole file'
      ]
    )
  ),
  [...B1, 'the whole file'],
  [
    'P1: the pinned workflow also granting statuses: write',
    LINKED,
    linkedWith('\n  checks: write\n', '\n  checks: write\n  statuses: write\n'),
    'the whole file'
  ],
  [
    'P2: the pinned workflow naming its check from a variable',
    LINKED,
    linkedWith('local name="linked-web-sdk-pr-ready"', 'local name="$CHECK_NAME"'),
    'the whole file'
  ],
  [
    'P3: the pinned workflow posting a second check run',
    LINKED,
    linkedWith(
      LINKED_POST,
      `${LINKED_POST}              gh api -X POST "repos/$GITHUB_REPOSITORY/check-runs" -f name="$CHECK_NAME" -f head_sha="$head_sha" >/dev/null\n`
    ),
    'the whole file'
  ],
  [
    'P4: the pinned workflow passing a computed name to its check run',
    LINKED,
    linkedWith('--arg name "$name"', '--arg name "local-e2e ($B)"'),
    'the whole file'
  ],
  [
    'P5: the pinned workflow computing its check name in jq',
    LINKED,
    linkedWith('{name: $name', '{name: ("local-e2e (" + $status + ")")'),
    'the whole file'
  ],
  [
    'P6: the pinned workflow with its check-run POST repeated',
    LINKED,
    linkedWith(LINKED_POST, LINKED_POST + LINKED_POST),
    'the whole file'
  ],
  [
    'P7: the pinned workflow adding a test reporter that names its check',
    LINKED,
    linkedWith(
      '      - uses: actions/checkout@v6\n',
      `      - uses: actions/checkout@v6\n\n      - uses: dorny/test-reporter@v1\n        with:\n          name: local-e2e (\${{ matrix.b }})\n`
    ),
    'the whole file'
  ],
  [...L1, 'a line'],
  [...L5, 'a line']
];

/** Each case is a workflow with one violation, on `line`, whose text must be `remedy` and then that line trimmed. */
const remedyCases: Array<[title: string, text: SourceText, line: number, remedy: string]> = [
  [
    'R1: a flow-form permissions: { contents: read }',
    `permissions: { contents: read }\n${ONE_JOB}`,
    1,
    REMEDY.permissionsShape
  ],
  [
    'R2: a run: step mentioning permissions',
    workflowWithStep('      - run: echo permissions\n'),
    7,
    REMEDY.permissionsWord
  ],
  ['R3: a quoted "on": key', `"on": push\n${READ_ONLY}${ONE_JOB}`, 1, REMEDY.quotedKey],
  ["R4: A1's check-run step", A1[2], 7, REMEDY.apiWrite],
  [
    'R5: a check-runs call inside a run: | body',
    workflowWithStep(`      - run: |\n          ${CHECK_RUN_COMMAND}\n`),
    8,
    REMEDY.apiWrite
  ],
  [
    "R6: a quoted 'shell': key after a - run: | body, at the step's key column",
    workflowWithStep("      - run: |\n          echo hi\n        'shell': bash\n"),
    9,
    REMEDY.quotedKey
  ],
  [
    "R7: a name: mentioning permissions after a - run: | body, at the step's key column",
    workflowWithStep('      - run: |\n          echo hi\n        name: set permissions\n'),
    9,
    REMEDY.permissionsWord
  ],
  [
    'R8: a quoted "permissions": key in a job after another job\'s run: | body',
    workflowWithStep(
      '      - run: |\n          echo hi\n  other-job:\n    runs-on: ubuntu-latest\n    "permissions":\n      contents: read\n'
    ),
    11,
    REMEDY.quotedKey
  ],
  [
    'R9: a permissions: | block scalar, whose key line is still read',
    `permissions: |\n  contents: read\n${ONE_JOB}`,
    1,
    REMEDY.permissionsShape
  ]
];

/** Workflows whose block scalar bodies hold text a key-shape rule would flag on a key line, each passing the API rule. */
const blockScalarPassCases: Array<[title: string, text: string]> = [
  [
    "a github-script body holding 'X-GitHub-Api-Version': '2022-11-28',",
    workflowWithStep(
      "      - uses: actions/github-script@v7\n        with:\n          script: |\n            await github.request('GET /rate_limit', {\n              headers: {\n                'X-GitHub-Api-Version': '2022-11-28',\n              },\n            });\n"
    )
  ],
  [
    'a run: | JSON heredoc holding "event_type": "x"',
    workflowWithStep(
      `      - run: |\n          gh api repos/$GITHUB_REPOSITORY/dispatches --input - <<'EOF'\n          {\n            "event_type": "x"\n          }\n          EOF\n`
    )
  ],
  [
    'a run: | body holding echo "set permissions" and permissions: {contents: read}',
    workflowWithStep(
      `      - run: |\n          echo "set permissions"\n          cat > generated.yml <<'EOF'\n          permissions: {contents: read}\n          EOF\n`
    )
  ]
];

/** Workflows refused whole for a line break, each with where its refusal must say the break is and the remedy for its kind. */
const lineBreakRemedyCases: Array<[title: string, text: string, where: string, fix: string]> = [
  [
    'a U+2028 in a step name on line 7',
    workflowWithStep('      - name: set\u2028up\n        run: echo hi\n'),
    'U+2028 on line 7',
    'delete the invisible character on that line'
  ],
  [
    'a bare CR ending line 7',
    workflowWithStep('      - name: setup\r        run: echo hi\n'),
    'U+000D on line 7',
    'save the file with LF line endings'
  ]
];

/** Script lines naming a required name, in a file where `#` starts a comment and in one where it does not. */
const literalRemedyCases: Array<[file: string, line: string]> = [
  ['scripts/x.sh', "echo 'local-e2e (chrome)'"],
  ['scripts/x.ts', '// local-e2e (chrome)']
];

describe('no workflow can report a required E2E check name except through the computed full-run form', () => {
  it('the checker passes on every file in .github/workflows today', () => {
    const violations = allWorkflowFiles().flatMap(file => workflowViolations(file, configSource(file)));
    expect(violations).toEqual([]);
  });

  it('parseJobs reads at least one job from every workflow, and each designated job from its own', () => {
    expect(allWorkflowFiles().filter(file => jobsOf(file, configSource(file)).length === 0)).toEqual([]);
    const missing = FULL_NAME_JOBS.filter(
      ({ file, jobId }) => !jobsOf(file, configSource(file)).some(job => job.jobId === jobId)
    );
    expect(missing).toEqual([]);
  });

  it.each(nameViolationCases)('%s -> the checker %s', (_title, expected, file, text) => {
    expect(checkerOutcome(file, text)).toBe(expected);
  });

  it.each(matrixWildcardCases)('%s -> the checker %s', (_title, expected, text) => {
    expect(checkerOutcome('synthetic-unenumerable-matrix.yml', text)).toBe(expected);
  });

  it.each(refusalMessageCases)('%s -> its refusal holds %j', (_title, message, file, text) => {
    expect(() => workflowViolations(file, text)).toThrow(message);
  });

  it.each(requiredNameLiteralCases)('%s -> the literal rule flags it', (_title, file, text, flagged) => {
    const violations = requiredNameLiteralViolations(file, sourceText(text));
    expect(violations.map(violation => ('name' in violation ? violation.name : 'the whole file'))).toContain(flagged);
  });

  it.each(apiWriterCases)('%s -> the API rule flags it', (_title, file, text, arm) => {
    const lines = apiWriterViolations(file, sourceText(text)).map(violation => violation.line);
    expect(lines.filter(line => (arm === 'the whole file' ? line === 0 : line > 0))).not.toEqual([]);
  });

  it.each(remedyCases)(
    '%s -> its one violation names its reason and remedy, then the line',
    (_title, text, line, remedy) => {
      const file = '.github/workflows/synthetic-remedy.yml';
      const source = sourceText(text);
      expect(apiWriterViolations(file, source)).toEqual([
        { file, line, text: `${remedy}: ${source.split('\n')[line - 1]!.trim()}` }
      ]);
    }
  );

  it.each(blockScalarPassCases)('%s -> passes the API rule', (_title, text) => {
    expect(apiWriterViolations('.github/workflows/synthetic-block-scalar.yml', text)).toEqual([]);
  });

  it.each(lineBreakRemedyCases)(
    '%s -> both rules refuse the file at line 0, saying where the break is and what to do',
    (_title, text, where, fix) => {
      const file = '.github/workflows/synthetic-line-break.yml';
      for (const rule of [apiWriterViolations, requiredNameLiteralViolations]) {
        expect(rule(file, text)).toEqual([{ file, line: 0, text: expect.stringContaining(`${fix}: ${where}`) }]);
      }
    }
  );

  it('a workflow with no top-level permissions block is one line-0 violation naming its remedy', () => {
    const file = '.github/workflows/synthetic-default-token.yml';
    expect(apiWriterViolations(file, `on: push\n${ONE_JOB}`)).toEqual([
      {
        file,
        line: 0,
        text: `no top-level permissions: block, which leaves the token the repository default permissions, ${REMEDY.defaultToken}`
      }
    ]);
  });

  it.each(literalRemedyCases)(
    '%s line %s -> one literal violation naming its remedy, which offers a # comment only in YAML or shell',
    (file, line) => {
      const violations = requiredNameLiteralViolations(file, `${line}\n`);
      expect(violations).toEqual([
        { file, line: 1, name: 'local-e2e (chrome)', text: `${REMEDY.requiredName}: ${line}` }
      ]);
      expect(violations[0]?.text).toContain('in a YAML or shell file move it to a `#` comment line');
    }
  );

  it('a non-designated job named a required name is one job-name violation naming its remedy', () => {
    const file = '.github/workflows/synthetic-job-name.yml';
    expect(
      workflowViolations(file, "jobs:\n  some-job:\n    name: 'local-e2e (chrome)'\n    runs-on: ubuntu-latest\n")
    ).toEqual([{ file, jobId: 'some-job', name: 'local-e2e (chrome)', text: `${REMEDY.jobName}: jobs.some-job` }]);
  });

  const designatedLocalWith = (strategy: string): string =>
    jobWithStrategy('chrome-local', `name: ${fullNameOf('local-e2e (chrome)')}\n${strategy}`);

  it.each([
    ['a block matrix', 'strategy:\n  matrix:\n    browser: [chrome]'],
    ['an inline strategy', 'strategy: { fail-fast: false }'],
    ['an inline strategy and a trailing comment', 'strategy: { fail-fast: false } # c']
  ])(
    'the designated Local job with %s is one violation under its own required name, told to drop the matrix',
    (_title, strategy) => {
      expect(workflowViolations(LOCAL, designatedLocalWith(strategy))).toEqual([
        {
          file: LOCAL,
          jobId: 'chrome-local',
          name: 'local-e2e (chrome)',
          text: `${REMEDY.designatedStrategy}: jobs.chrome-local`
        }
      ]);
    }
  );

  it('the designated Local job with a block strategy and no matrix has no violations', () => {
    expect(workflowViolations(LOCAL, designatedLocalWith('strategy:\n  fail-fast: false'))).toEqual([]);
  });

  it('the designated Local job whose strategy: value is only a comment, over no matrix, has no violations', () => {
    const strategy = 'strategy: # keep the other jobs\n  fail-fast: false';
    expect(workflowViolations(LOCAL, designatedLocalWith(strategy))).toEqual([]);
  });

  it.each<[title: string, names: string[], strategy: string]>([
    [
      'a strategy: value that is only a comment over a firefox matrix',
      [],
      'strategy: # c\n  matrix:\n    browser: [firefox]'
    ],
    [
      'a strategy: value that is only a comment over a chrome matrix',
      ['local-e2e (chrome)'],
      'strategy: # c\n  matrix:\n    browser: [chrome]'
    ],
    [
      'an inline strategy and a trailing comment',
      ['local-e2e (chrome)'],
      'strategy: { matrix: { browser: [chrome] } } # c'
    ],
    [
      'a matrix: value that is only a comment over a firefox axis',
      [],
      'strategy:\n  matrix: # c\n    browser: [firefox]'
    ],
    [
      'a matrix: value that is only a comment over a chrome axis',
      ['local-e2e (chrome)'],
      'strategy:\n  matrix: # c\n    browser: [chrome]'
    ],
    [
      'an axis value that is only a comment over a firefox item',
      [],
      'strategy:\n  matrix:\n    browser: # x\n      - firefox'
    ],
    [
      'an axis value that is only a comment over a chrome item',
      ['local-e2e (chrome)'],
      'strategy:\n  matrix:\n    browser: # x\n      - chrome'
    ]
  ])('a local-e2e job with %s -> job-name violations under %j', (_title, names, strategy) => {
    const file = '.github/workflows/synthetic-commented-strategy.yml';
    expect(workflowViolations(file, jobWithStrategy('local-e2e', strategy))).toEqual(
      names.map(name => ({ file, jobId: 'local-e2e', name, text: `${REMEDY.jobName}: jobs.local-e2e` }))
    );
  });

  it('matrixJobIds lists a job with a matrix it can list or cannot, and not one whose strategy has none', () => {
    expect(matrixJobIds(LOCAL, designatedLocalWith('strategy: # c\n  fail-fast: false'))).toEqual([]);
    expect(matrixJobIds(LOCAL, designatedLocalWith('strategy:\n  matrix:\n    browser: [chrome]'))).toEqual([
      'chrome-local'
    ]);
    expect(
      matrixJobIds(LOCAL, designatedLocalWith('strategy:\n  matrix:\n    include:\n      - browser: chrome'))
    ).toEqual(['chrome-local']);
  });

  it('a four-space-indented workflow is refused with an error naming its file and the plain shape', () => {
    const file = 'synthetic-four-space-id.yml';
    const text = 'jobs:\n    bridge-guardian-e2e-gate:\n      runs-on: ubuntu-latest\n';
    expect(checkerOutcome(file, text)).toBe('throws');
    expect(() => workflowViolations(file, text)).toThrow(
      new Error(`${file}: unreadable line at indent 2: "    bridge-guardian-e2e-gate:", ${REMEDY.plainShape}`)
    );
  });

  it.each(LEVELS.flatMap(level => READABLE_GRANTS.map((entry): [Level, string] => [level, entry])))(
    'a %s %j passes the API rule',
    (level, entry) => {
      expect(apiWriterViolations('.github/workflows/synthetic-grant.yml', workflowWith(level, entry))).toEqual([]);
    }
  );

  it('every case built from a live repository file holds a function, so only that case reads the file', () => {
    const live = [...requiredNameLiteralCases, ...apiWriterCases].filter(
      ([, file]) => statSync(resolve(repoRoot, file), { throwIfNoEntry: false })?.isFile() === true
    );
    expect(live.map(([, file]) => file)).toEqual(expect.arrayContaining([LINKED, LOCAL]));
    expect(live.filter(([, , text]) => typeof text !== 'function').map(([title]) => title)).toEqual([]);
  });

  it('A1 names no required name literally, so only the API rule catches it', () => {
    const [, file, text] = A1;
    expect(requiredNameLiteralViolations(file, sourceText(text))).toEqual([]);
  });

  it("A1's check-run step is one violation whose text says how to clear it", () => {
    const [, file, text] = A1;
    expect(apiWriterViolations(file, sourceText(text)).map(violation => violation.text)).toEqual([
      expect.stringContaining(
        'so remove the call or grant, or have a person confirm the file never reports a required name and pin it in API_WRITER_ALLOWLIST'
      )
    ]);
  });

  it('a comment line naming a required name passes the literal rule', () => {
    const text = `# ${REQUIRED_NAMES.join(', ')}\nset -e\n    # ${REQUIRED_NAMES.join(', ')}\n`;
    expect(requiredNameLiteralViolations('scripts/x.sh', text)).toEqual([]);
  });

  it.each(FULL_NAME_JOBS)('the real $file reports $name and passes the literal rule', ({ file, name }) => {
    const text = configSource(file);
    expect(text).toContain(name);
    expect(requiredNameLiteralViolations(file, text)).toEqual([]);
  });

  it('the real check-linked-web-sdk-pr.yml writes the Checks API and passes the API rule at its pinned hash', () => {
    const text = configSource(LINKED);
    expect(text).toContain('checks: write');
    expect(apiWriterViolations(LINKED, text)).toEqual([]);
  });

  it('P8: a routine edit to the pinned workflow is one violation for the whole file, naming its pinned sha256', () => {
    expect(apiWriterViolations(LINKED, `${configSource(LINKED)}# routine edit\n`)).toEqual([
      { file: LINKED, line: 0, text: expect.stringContaining('update its pinned sha256') }
    ]);
  });

  it('ciSourceFiles() reaches every workflow, action and script CI can run, and skips docs, the lockfile and this file', () => {
    const files = ciSourceFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        '.github/actions/inject-linked-web-sdk-pr/action.yml',
        'scripts/select-e2e-changes.sh',
        'playwright/e2e/local-stack/run-note-transport.sh',
        ...allWorkflowFiles()
      ])
    );
    for (const skipped of ['CHANGELOG.md', 'yarn.lock', 'playwright/e2e/harness/spec-selection.test.ts']) {
      expect(files).not.toContain(skipped);
    }
  });

  it('M1: ciSourceFilter skips a listed path missing from the worktree instead of throwing', () => {
    expect(ciSourceFilter(['scripts/synthetic-missing.sh', 'scripts/select-e2e-changes.sh'])).toEqual([
      'scripts/select-e2e-changes.sh'
    ]);
  });

  it('neither rule finds anything in any file CI can run today', () => {
    const sources: Array<[string, string]> = ciSourceFiles().map(file => [file, configSource(file)]);
    expect(sources.flatMap(([file, text]) => requiredNameLiteralViolations(file, text))).toEqual([]);
    expect(sources.flatMap(([file, text]) => apiWriterViolations(file, text))).toEqual([]);
  });
});

describe('a stacked-named gate skips instead of computing a pass on a stacked pull request', () => {
  it.each([
    ['.github/workflows/pr-e2e-bridge-guardian.yml', 'bridge-guardian-e2e-gate:'],
    ['.github/workflows/pr-e2e-guardian-lifecycle.yml', 'guardian-lifecycle-e2e-gate:']
  ])('%s %s runs only under !cancelled() && (FULL)', (file, anchor) => {
    expect(jobIfAfter(file, anchor)).toBe(`\${{ !cancelled() && (${FULL}) }}`);
  });

  it('the Bridge gate step env holds RESULT from needs.bridge-guardian-e2e.result, with no EVENT_NAME or BASE_REF', () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    const gateSrc = src.slice(src.indexOf('bridge-guardian-e2e-gate:'));
    expect(gateSrc).toMatch(/RESULT: \$\{\{ needs\.bridge-guardian-e2e\.result \}\}/);
    expect(gateSrc).not.toMatch(/EVENT_NAME/);
    expect(gateSrc).not.toMatch(/BASE_REF/);
  });

  it.each<[string, number]>([
    ['success', 0],
    ['skipped', 1],
    ['failure', 1],
    ['cancelled', 1]
  ])('the Bridge gate script: result=%s -> exit %i', (result, expected) => {
    const script = runBlockAfter('.github/workflows/pr-e2e-bridge-guardian.yml', 'bridge-guardian-e2e-gate:');
    expect(gateExit(script, { RESULT: result })).toBe(expected);
  });
});

describe('guardian-lifecycle-e2e-gate keeps its selector and run logic', () => {
  it.each<[string, string, string, number]>([
    ['success', 'false', 'skipped', 0],
    ['success', 'true', 'skipped', 1],
    ['success', 'true', 'success', 0],
    ['failure', 'true', 'success', 1],
    ['success', '', 'skipped', 1],
    ['success', 'maybe', 'success', 1],
    ['success', 'false', 'success', 1],
    ['success', 'false', 'failure', 1]
  ])('select=%s run=%p e2e=%s -> exit %i', (selectResult, selected, e2eResult, expected) => {
    const script = runBlockAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', 'guardian-lifecycle-e2e-gate:');
    const status = gateExit(script, {
      'needs.select-guardian-e2e.result': selectResult,
      'needs.select-guardian-e2e.outputs.run': selected,
      'needs.guardian-lifecycle-e2e.result': e2eResult
    });
    expect(status).toBe(expected);
  });
});

describe('PR workflows run the heavy E2E jobs only on a pull request based on main or next', () => {
  it("select-guardian-e2e's job-level if: pins FULL, so a stacked pull request skips its full-history checkout and pull request read along with it", () => {
    expect(jobIfAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', 'select-guardian-e2e:')).toBe(
      `\${{ ${FULL} }}`
    );
  });

  it('the Guardian selector runs on a linked-PR marker, skips a pull request with no marker and no changed path, and runs on push and dispatch', () => {
    const body = runBlockAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', '- name: Check changed paths');
    // HEAD...HEAD is an empty diff, so a pull request with no marker has no path to select it.
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
    expect(head).toMatch(/^[0-9a-f]{40,64}$/);
    const arms = [
      { GITHUB_EVENT_NAME: 'pull_request', PR_BODY: 'Guardian PR: #5', expected: 'run=true' },
      { GITHUB_EVENT_NAME: 'pull_request', PR_BODY: '', expected: 'run=false' },
      { GITHUB_EVENT_NAME: 'push', PR_BODY: '', expected: 'run=true' },
      { GITHUB_EVENT_NAME: 'workflow_dispatch', PR_BODY: '', expected: 'run=true' }
    ];
    for (const { GITHUB_EVENT_NAME, PR_BODY, expected } of arms) {
      const dir = mkdtempSync(join(tmpdir(), 'guardian-select-'));
      const outputFile = join(dir, 'output');
      try {
        const result = spawnSync('bash', ['-eo', 'pipefail', '-c', body], {
          cwd: repoRoot,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME,
            PR_BODY,
            BASE_SHA: head,
            HEAD_SHA: head,
            GITHUB_OUTPUT: outputFile
          }
        });
        expect(result.status).toBe(0);
        expect(readFileSync(outputFile, 'utf8')).toContain(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('the E2E workflows trigger on exactly their intended events, so no label re-runs a gate', () => {
    expect(onBlock('.github/workflows/pr-e2e-local.yml')).toBe('  pull_request:\n  workflow_dispatch: {}');
    expect(onBlock('.github/workflows/pr-e2e-guardian-lifecycle.yml')).toBe(
      '  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch: {}'
    );
    expect(onBlock('.github/workflows/pr-e2e-bridge-guardian.yml')).toBe(
      '  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch: {}'
    );
  });

  it('runBlockAfter throws when the anchor is not found, instead of matching the first run block in the file', () => {
    expect(() => runBlockAfter('.github/workflows/pr-e2e-local.yml', 'this anchor does not exist anywhere')).toThrow(
      'no anchor "this anchor does not exist anywhere" found in .github/workflows/pr-e2e-local.yml'
    );
  });
});

/** Configs whose testDir also holds Jest suites, which Playwright's default testMatch would load and fail on. */
const jestSharingConfigs = [
  { config: 'playwright.stress.config.ts', spec: 'stress.spec.ts' },
  { config: 'playwright.store-listing.config.ts', spec: 'store-listing.capture.spec.ts' }
];

describe('configs whose testDir holds Jest suites load only their Playwright specs', () => {
  it.each(jestSharingConfigs)('$config', ({ config, spec }) => {
    const list = listPlaywrightTests(config);
    expect(list).toContain(spec);
    expect(list).not.toMatch(/\.test\.ts/);
  });
});

// Declared last: Jest runs this file's tests in order, so the check sees every list run above.
describe('list runs write no report files', () => {
  it('leaves every json report as it was', () => {
    expect(reportFiles.map(reportStamp)).toEqual(reportsBefore);
  });
});
