import { spawnSync } from 'node:child_process';
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
    expect(src).not.toMatch(/strategy:/);
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
const WORKFLOW_FILES = [
  '.github/workflows/pr-e2e-local.yml',
  '.github/workflows/pr-e2e-guardian-lifecycle.yml',
  '.github/workflows/pr-e2e-bridge-guardian.yml'
];
const combinedWorkflowSource = (): string => WORKFLOW_FILES.map(configSource).join('\n');

/** The FULL condition guarding a job's computed `name: ${{ (FULL) && '<required>' || '<required> (stacked)' }}`. */
const fullFromName = (file: string): string => {
  const match = /name:\s*\$\{\{\s*\(([\s\S]+?)\)\s*&&/.exec(configSource(file));
  if (!match) throw new Error(`no computed name found in ${file}`);
  return match[1]!.trim();
};

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
    if (!match || entries.some(entry => entry.key === match[1])) {
      throw new Error(`unreadable line at indent ${indent}: ${JSON.stringify(line)}`);
    }
    entries.push({ key: match[1]!, value: (match[2] ?? '').trim(), block: [] });
  }
  return entries;
};

type ParsedJob = { jobId: string; rawName: string | null; matrix: { combos: string[] | null } | null };

/** A job's matrix: none, `combos: null` when it has an include, an exclude, any `${{ }}` or inline content, else every combination of its axes. */
const readMatrix = (strategy: MappingEntry): ParsedJob['matrix'] => {
  if (strategy.value !== '') throw new Error(`strategy with inline content ${JSON.stringify(strategy.value)}`);
  const matrix = readMapping(strategy.block, 6).find(entry => entry.key === 'matrix');
  if (!matrix) return null;
  if (matrix.value !== '' || matrix.block.some(line => line.includes('${{'))) return { combos: null };
  const axes = readMapping(matrix.block, 8);
  if (axes.some(axis => axis.key === 'include' || axis.key === 'exclude')) return { combos: null };
  const values = axes.map(({ key, value, block }) => {
    const flow = /^\[([^\]]*)\]$/.exec(value);
    if (flow && block.length === 0) return flow[1]!.split(',').map(readScalar);
    const items = block.map(line => /^\s+- (.*)$/.exec(line)?.[1]);
    if (value !== '' || items.length === 0 || items.includes(undefined)) {
      throw new Error(`unreadable matrix axis ${key}`);
    }
    return items.map(item => readScalar(item!));
  });
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
 * job keys at indent 4, a one-line `name:` scalar, and a matrix of flow or block-sequence
 * axes under `strategy:`. Anything else throws, since a shape this cannot read could hide a
 * required name. No YAML parser is a direct dependency, so this reads text.
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

type NameViolation = { file: string; jobId: string; name: string };

/** Whether `job` is its workflow's designated job, named exactly the FULL ternary of its own required name, with no matrix. */
const isDesignatedFullName = (file: string, job: ParsedJob): boolean => {
  const designated = FULL_NAME_JOBS.find(entry => entry.file === file && entry.jobId === job.jobId);
  const ternary = TERNARY_NAME.exec(job.rawName ?? '');
  return (
    designated !== undefined &&
    ternary !== null &&
    job.matrix === null &&
    ternary[1]!.trim() === FULL &&
    ternary[2] === designated.name &&
    ternary[3] === `${designated.name} (stacked)`
  );
};

/**
 * Every required name one job could report other than as its designated FULL name. A
 * matrix job's name counts with and without its combination suffix: GitHub leaves the
 * suffix off a name that references the matrix, which an expression may or may not do.
 */
const jobViolations = (file: string, job: ParsedJob, required: string[]): NameViolation[] => {
  if (isDesignatedFullName(file, job)) return [];
  const combos = job.matrix?.combos?.map(escapeRegExp).join('|') ?? '.*';
  const suffix = job.matrix ? `(?: \\((?:${combos})\\))?` : '';
  const pattern = new RegExp(`^${wildcardFromName(job.rawName ?? job.jobId)}${suffix}$`);
  return required.filter(name => pattern.test(name)).map(name => ({ file, jobId: job.jobId, name }));
};

/** Every C-06 violation in one workflow file's text, taking (file, text) so the real tree and synthetic cases share this one code path. */
const workflowViolations = (file: string, text: string): NameViolation[] =>
  parseJobs(text).flatMap(job => jobViolations(file, job, REQUIRED_NAMES));

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
 * Every tracked file CI can run: all but docs, Markdown, the lockfile, this file and binaries.
 * A tracked symlink to a directory is skipped, since the files under it are tracked themselves.
 */
const ciSourceFiles = (): string[] => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split('\0')
    .filter(
      file =>
        file !== '' && !file.startsWith('docs/') && !file.endsWith('.md') && file !== 'yarn.lock' && file !== THIS_FILE
    )
    .filter(file => statSync(resolve(repoRoot, file)).isFile() && !looksBinary(file));
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

type LiteralViolation = { file: string; line: number; name: string };

/**
 * Every content line naming a required name anywhere but where its designated job reports it:
 * that job's own `name:` line and, for a gate, its own id line, both in its designated file, or
 * a `needs:` entry naming the gate. A name computed at run time is left to the API rule.
 */
const requiredNameLiteralViolations = (file: string, text: string): LiteralViolation[] => {
  const lines = text.split(/\r?\n/);
  const allowed = (name: string, at: number): boolean =>
    FULL_NAME_JOBS.some(job => {
      if (job.name !== name) return false;
      const isGate = job.jobId === name;
      if (isGate && needsEntries(lines[at]!).includes(name)) return true;
      if (job.file !== file) return false;
      const { idAt, nameAt } = jobLines(lines, job.jobId);
      return at === nameAt || (isGate && at === idAt);
    });
  return lines.flatMap((line, at) =>
    isContent(line)
      ? REQUIRED_NAMES.filter(name => line.includes(name) && !allowed(name, at)).map(name => ({
          file,
          line: at + 1,
          name
        }))
      : []
  );
};

/**
 * The only files that may write the Checks or Statuses API. A file joins this list only after
 * a human confirms it never reports a required E2E name.
 */
const API_WRITER_ALLOWLIST = ['.github/workflows/check-linked-web-sdk-pr.yml'];

const API_WRITE = /check-runs|\/statuses\b|checks\.(create|update)|createCommitStatus|\b(checks|statuses):\s*write\b/;

type ApiViolation = { file: string; line: number; text: string };

/** Every content line that could write the Checks or Statuses API, or grants that write, in a file off the allowlist. */
const apiWriterViolations = (file: string, text: string): ApiViolation[] =>
  API_WRITER_ALLOWLIST.includes(file)
    ? []
    : text
        .split(/\r?\n/)
        .flatMap((line, at) =>
          isContent(line) && API_WRITE.test(line) ? [{ file, line: at + 1, text: line.trim() }] : []
        );

describe('a stacked pull request reports its E2E checks under names no branch requires', () => {
  it.each(REQUIRED_NAMES)('%s is reported as itself or as (stacked), never as a bare literal name', required => {
    const src = combinedWorkflowSource();
    const escaped = required.replace(/[()]/g, '\\$&');
    expect(src).toMatch(
      new RegExp(
        `name:\\s*\\$\\{\\{\\s*\\([\\s\\S]+?\\)\\s*&&\\s*'${escaped}'\\s*\\|\\|\\s*'${escaped} \\(stacked\\)'\\s*\\}\\}`
      )
    );
  });

  it.each(WORKFLOW_FILES)(
    'the required-name job in %s computes its name from FULL literally, not just some condition',
    file => {
      expect(fullFromName(file)).toBe(FULL);
    }
  );

  it("chrome-local's if: matches the FULL condition inside its own computed name", () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    const ifMatch = /\n\s+if: \$\{\{ (github\.event_name[\s\S]+?) \}\}\n/.exec(src);
    expect(ifMatch).not.toBeNull();
    expect(ifMatch![1]!.trim()).toBe(fullFromName('.github/workflows/pr-e2e-local.yml'));
  });

  it("bridge-guardian-e2e's if: matches the FULL condition inside its gate's computed name", () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    const ifMatch = /\n\s+if: (github\.event_name[\s\S]+?)\n/.exec(src);
    expect(ifMatch).not.toBeNull();
    expect(ifMatch![1]!.trim()).toBe(fullFromName('.github/workflows/pr-e2e-bridge-guardian.yml'));
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
  [
    'a job-level <<: merge key',
    'throws',
    'synthetic-merge-key.yml',
    'jobs:\n  base:\n    runs-on: ubuntu-latest\n    env: &gate\n      name: bridge-guardian-e2e-gate\n  some-job:\n    <<: *gate\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a job with two name: keys',
    'throws',
    'synthetic-two-names.yml',
    'jobs:\n  some-job:\n    name: some-job\n    name: bridge-guardian-e2e-gate\n    runs-on: ubuntu-latest\n'
  ],
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
    'throws',
    'synthetic-inline-strategy.yml',
    'jobs:\n  local-e2e:\n    strategy: { matrix: { browser: [chrome] } }\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a matrix axis value it cannot read',
    'throws',
    'synthetic-tagged-axis.yml',
    'jobs:\n  local-e2e:\n    strategy:\n      matrix:\n        browser: [!!str chrome]\n    runs-on: ubuntu-latest\n'
  ]
];

/** A workflow whose one job runs `step`, a steps-list item already indented and newline-terminated. */
const workflowWithStep = (step: string): string =>
  `jobs:\n  some-job:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;

const CHECK_RUN_COMMAND =
  "gh api repos/$GITHUB_REPOSITORY/check-runs -f name='local-e2e (chrome)' -f head_sha=$SHA -f conclusion=success";

type SourceCase = [title: string, file: string, text: string];

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

/** Each case is a source file the literal rule must flag, with the required name it must flag there. */
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
    `${configSource(LOCAL)}  other-job:\n    name: 'local-e2e (chrome)'\n    runs-on: ubuntu-latest\n`,
    'local-e2e (chrome)'
  ]
];

/** Each case is a source file the API rule must flag. */
const apiWriterCases: SourceCase[] = [
  A1,
  [
    'A2: a workflow granting checks: write',
    '.github/workflows/synthetic-checks-write.yml',
    'permissions:\n  checks: write\njobs:\n  some-job:\n    runs-on: ubuntu-latest\n'
  ],
  L1,
  L5
];

describe('no workflow can report a required E2E check name except through the computed full-run form', () => {
  it('the checker passes on every file in .github/workflows today', () => {
    const violations = allWorkflowFiles().flatMap(file => workflowViolations(file, configSource(file)));
    expect(violations).toEqual([]);
  });

  it('parseJobs reads at least one job from every workflow, and each designated job from its own', () => {
    expect(allWorkflowFiles().filter(file => parseJobs(configSource(file)).length === 0)).toEqual([]);
    const missing = FULL_NAME_JOBS.filter(
      ({ file, jobId }) => !parseJobs(configSource(file)).some(job => job.jobId === jobId)
    );
    expect(missing).toEqual([]);
  });

  it.each(nameViolationCases)('%s -> the checker %s', (_title, expected, file, text) => {
    expect(checkerOutcome(file, text)).toBe(expected);
  });

  it.each(requiredNameLiteralCases)('%s -> the literal rule flags it', (_title, file, text, name) => {
    expect(requiredNameLiteralViolations(file, text).map(violation => violation.name)).toContain(name);
  });

  it.each(apiWriterCases)('%s -> the API rule flags it', (_title, file, text) => {
    expect(apiWriterViolations(file, text)).not.toEqual([]);
  });

  it('A1 names no required name literally, so only the API rule catches it', () => {
    const [, file, text] = A1;
    expect(requiredNameLiteralViolations(file, text)).toEqual([]);
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

  it('the real check-linked-web-sdk-pr.yml writes the Checks API and passes the API rule', () => {
    const file = '.github/workflows/check-linked-web-sdk-pr.yml';
    const text = configSource(file);
    expect(text).toContain('checks: write');
    expect(apiWriterViolations(file, text)).toEqual([]);
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
