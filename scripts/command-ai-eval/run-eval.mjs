import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
// loadTsModule compiles TypeScript only, so the Worker's one .mjs import is handed to it.
const WORKER_MODULES = {
  './help-safety.mjs': await import('../../services/command-ai/src/help-safety.mjs')
};

function loadTsModule(relPath, moduleMocks = {}) {
  const fullPath = path.join(ROOT, relPath);
  const src = readFileSync(fullPath, 'utf8');
  const transpiled = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  const mod = { exports: {} };
  const localRequire = spec => {
    if (spec in moduleMocks) return moduleMocks[spec];
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(fullPath), spec);
      if (target.endsWith('.json')) return require(target);
      const tsPath = target.endsWith('.ts') ? target : `${target}.ts`;
      return loadTsModule(path.relative(ROOT, tsPath), moduleMocks);
    }
    return require(spec);
  };
  const fn = new Function('require', 'module', 'exports', transpiled.outputText);
  fn(localRequire, mod, mod.exports);
  return mod.exports;
}

const TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 200;
const TRANSIENT_RETRY_BUDGET_MS = 120000;
const NETWORK_FAILURE_MARKERS = ['timed out', 'fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'socket hang up'];

// Worker 502 is compilationFailed, which also covers a malformed model reply, so it stays final.
export function isTransientEvalError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const workerStatus = /Worker returned (\d+)/.exec(message);
  if (workerStatus) return workerStatus[1] === '429' || workerStatus[1] === '504';
  if (error instanceof Error && error.name === 'AbortError') return true;
  const statusCode =
    error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  if (statusCode === 429 || statusCode === 504) return true;
  if (typeof statusCode === 'number') return false;
  return NETWORK_FAILURE_MARKERS.some(marker => message.includes(marker));
}

function freshRetryBudget() {
  const configured = Number.parseInt(process.env.COMMAND_AI_EVAL_RETRY_BUDGET_MS ?? '', 10);
  return { remainingMs: configured >= 0 ? configured : TRANSIENT_RETRY_BUDGET_MS };
}

const UNKNOWN_RESET_MS = 60000;
const PACE_TOKEN_MARGIN = 600;
const RESET_UNIT_MS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

export function parseResetMs(value) {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(value)) return UNKNOWN_RESET_MS;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  return Math.round(parts.reduce((total, [, count, unit]) => total + Number(count) * RESET_UNIT_MS[unit], 0));
}

export function paceDelayMs(headers, lastPromptTokens) {
  const remaining = headers.get('x-ratelimit-remaining-tokens');
  // Live traffic shares the account, so a suite never takes more than half of a model's bucket.
  const half = Number(headers.get('x-ratelimit-limit-tokens') ?? 0) / 2;
  if (remaining === null || Number(remaining) >= Math.max(half, lastPromptTokens + PACE_TOKEN_MARGIN)) return 0;
  return parseResetMs(headers.get('x-ratelimit-reset-tokens') ?? '');
}

function retryAfterSecondsOf(error) {
  const seconds = error instanceof Error ? error.retryAfterSeconds : undefined;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

export async function retryTransient(run, budget = freshRetryBudget()) {
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt === TRANSIENT_ATTEMPTS || !isTransientEvalError(error)) throw error;
      const headerSeconds = retryAfterSecondsOf(error);
      const delayMs = headerSeconds === undefined ? TRANSIENT_BACKOFF_MS * attempt : headerSeconds * 1000;
      if (delayMs > budget.remainingMs) throw error;
      budget.remainingMs -= delayMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

const MIN_TOKEN_LIMIT = 8000;
const MIN_REQUEST_LIMIT = 1000;

/** Why a suite must stop to leave the production account its quota, if it must. `requests` counts a day. */
export function quotaStopReason(model, headers) {
  const header = name => {
    const value = headers.get(`x-ratelimit-${name}`);
    return value === null ? null : Number(value);
  };
  const tokens = header('limit-tokens');
  const requests = header('limit-requests');
  const left = header('remaining-requests');
  if (tokens !== null && tokens <= MIN_TOKEN_LIMIT) return `${model} allows only ${tokens} tokens a minute`;
  if (requests !== null && requests <= MIN_REQUEST_LIMIT) return `${model} allows only ${requests} requests a day`;
  if (requests !== null && left !== null && left < requests / 2) {
    return `${model} has ${left} of ${requests} requests left today`;
  }
  return null;
}

/** Ends a suite with no verdict. */
export class QuotaStop extends Error {
  constructor(reason) {
    super(`Quota stop: ${reason}. Only the measure suite may run on this limit.`);
    this.quotaStop = true;
  }
}

const readJson = file => JSON.parse(readFileSync(path.join(__dirname, file), 'utf8'));
const DEFAULT_CONTEXT = readJson('eval-context.json');
const DEFAULT_EVAL_MODEL = () => process.env.COMMAND_AI_MODEL || 'openai/gpt-oss-120b';
const helpDataset = () => readJson('../../services/command-ai/src/help-cards.json');
const UNKNOWN_CARDS = ['not_covered', 'cannot_diagnose'];
const INTENT_OPS = ['set_intent', 'set_plan'];

function loadAppModules() {
  const schemaMod = loadTsModule('src/lib/command-ai/schema.ts');
  return { schemaMod, redactorMod: loadTsModule('src/lib/command-ai/redactor.ts', { './schema': schemaMod }) };
}

const loadWorker = () => loadTsModule('services/command-ai/src/index.ts', WORKER_MODULES);
const loadHelpWrite = () => loadTsModule('services/command-ai/src/help-write.ts', WORKER_MODULES);

/**
 * The real Worker with paced provider calls. `compile` also returns the Worker's help trace, and `call` makes one
 * writer or checker call. Waits happen between requests, never inside one: the Worker gives writing 9 seconds.
 */
export function createEvalWorker({ model = DEFAULT_EVAL_MODEL(), dataset, guard = false, paced = true } = {}) {
  const stats = { maxPromptTokens: 0, promptTokens: 0, rateLimitHeaders: null, pacedMs: 0, models: {}, last: {} };
  const delays = new Map();
  let quotaStop = null;
  let providerFailureDetail;
  let trace;
  const workerModule = loadWorker();

  const fetchImpl = async (url, init) => {
    const requested = JSON.parse(String(init.body)).model;
    providerFailureDetail = undefined;
    const started = Date.now();
    const response = await fetch(url, init);
    const body = await response.text();
    let data = null;
    try {
      data = JSON.parse(body);
    } catch {}
    const promptTokens = data?.usage?.prompt_tokens ?? 0;
    if (requested === model) {
      stats.promptTokens = promptTokens;
      stats.maxPromptTokens = Math.max(stats.maxPromptTokens, promptTokens);
    }
    const limits = Object.fromEntries([...response.headers].filter(([name]) => name.startsWith('x-ratelimit-')));
    if (Object.keys(limits).length > 0 && requested === model) stats.rateLimitHeaders = limits;
    const usage = (stats.models[requested] ??= { calls: 0, promptTokens: 0, completionTokens: 0, headers: null });
    usage.calls += 1;
    usage.promptTokens += promptTokens;
    usage.completionTokens += data?.usage?.completion_tokens ?? 0;
    if (Object.keys(limits).length > 0) usage.headers = limits;
    stats.last[requested] = {
      status: response.status,
      promptTokens,
      completionTokens: data?.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
      respondedAt: Date.now(),
      headers: limits
    };
    const finishReason = data?.choices?.[0]?.finish_reason;
    providerFailureDetail = !response.ok
      ? `provider HTTP ${response.status}`
      : ['stop', 'length', 'content_filter', 'tool_calls'].includes(finishReason)
        ? `provider finish ${finishReason}`
        : undefined;
    // A 429 is waited for once, by retryTransient, which charges that wait to the retry budget.
    delays.set(requested, response.status === 429 ? 0 : paceDelayMs(response.headers, promptTokens));
    if (guard) quotaStop ??= quotaStopReason(requested, response.headers);
    return new Response(response.status === 204 ? null : body, {
      status: response.status,
      headers: response.headers
    });
  };

  async function pace() {
    if (quotaStop) throw new QuotaStop(quotaStop);
    if (!paced) return;
    const delayMs = Math.max(0, ...delays.values());
    delays.clear();
    if (delayMs > 0) {
      stats.pacedMs += delayMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const services = new Map();
  function serviceFor(override) {
    if (!services.has(override)) {
      const onTrace = value => {
        trace = value;
      };
      services.set(override, workerModule.createService({ dataset: override, onTrace, fetchImpl }));
    }
    return services.get(override);
  }

  async function compile(body, { dataset: override = dataset } = {}) {
    await pace();
    providerFailureDetail = undefined;
    trace = undefined;
    stats.promptTokens = 0;
    const response = await serviceFor(override).fetch(
      new Request('https://command-ai.test/v1/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }),
      {
        ALLOWED_ORIGINS: '[]',
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        COMMAND_AI_MODEL: model,
        COMMAND_AI_RATE_LIMIT: { limit: async () => ({ success: true }) }
      }
    );
    if (response.ok) return { ...(await response.json()), trace };
    const detail = response.status === 502 && providerFailureDetail ? ` (${providerFailureDetail})` : '';
    const error = new Error(`Worker returned ${response.status}${detail}`);
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      if (typeof header === 'string' && /^\d+$/.test(header)) {
        const seconds = Number(header);
        if (Number.isSafeInteger(seconds)) error.retryAfterSeconds = seconds;
      }
    }
    throw error;
  }

  async function call(request) {
    await pace();
    return workerModule.askModel({ ...request, fetchImpl, apiKey: process.env.GROQ_API_KEY });
  }

  return { stats, compile, call, model };
}

/** Sends each help question `runs` times, redacted as the app would send it. */
export async function runSelection({ cases, runs = 3, service = createEvalWorker() }) {
  const { schemaMod, redactorMod } = loadAppModules();
  const budget = freshRetryBudget();
  const results = [];
  for (const item of cases) {
    const { redactedText } = redactorMod.redactPrompt(item.q, DEFAULT_CONTEXT);
    const result = {
      id: item.id,
      cluster: item.cluster,
      class: item.class,
      priority: item.priority,
      set: item.set ?? item.split,
      cards: item.cards,
      forbidCards: item.forbidCards,
      benignHowTo: item.benignHowTo === true,
      runs: []
    };
    results.push(result);
    for (let attempt = 0; attempt < runs; attempt++) {
      try {
        const reply = await retryTransient(
          () => service.compile({ redactedText, helpContext: item.helpContext }),
          budget
        );
        result.runs.push({
          op: schemaMod.parseAiCompilerOutput(reply.output)?.op ?? 'invalid',
          served: reply.trace?.served ?? null,
          unknownIds: reply.trace?.unknownIds ?? [],
          promptTokens: service.stats.promptTokens
        });
      } catch (error) {
        if (error?.quotaStop) throw error;
        result.runs.push({ op: 'error', served: null, unknownIds: [], promptTokens: 0, error: error?.message });
      }
    }
  }
  return results;
}

const isUnknownReply = run => UNKNOWN_CARDS.includes(run.served);
const isAnswered = run => run.served !== null && !isUnknownReply(run);

// A cluster counts once and is right only if every run of every member is.
function clusterShare(members, isRight) {
  const clusters = new Map();
  for (const member of members) {
    clusters.set(
      member.cluster,
      (clusters.get(member.cluster) ?? true) && member.runs.every(run => isRight(member, run))
    );
  }
  return clusters.size === 0 ? null : [...clusters.values()].filter(Boolean).length / clusters.size;
}

export function scoreSelection(results) {
  const urgent = new Set(
    helpDataset()
      .cards.filter(card => card.urgent)
      .map(card => card.id)
  );
  const inClass = (set, name) => results.filter(item => item.set === set && item.class === name);
  const accepted = set =>
    clusterShare(
      inClass(set, 'answerable').filter(item => item.runs.some(isAnswered)),
      (item, run) => !isAnswered(run) || item.cards.includes(run.served)
    );
  const gated = results.some(item => item.set === 'holdout') ? 'holdout' : 'dev';
  const refused = name => clusterShare(inClass(gated, name), (_, run) => isUnknownReply(run));
  const idsWith = (include, matches) =>
    results.filter(item => include(item) && item.runs.some(run => matches(item, run))).map(item => item.id);
  const isHelp = item => ['answerable', 'near_miss', 'out_of_scope'].includes(item.class);
  const allRuns = results.flatMap(item => item.runs);
  return {
    devAccepted: accepted('dev'),
    holdoutAccepted: accepted('holdout'),
    answeredRate: clusterShare(inClass(gated, 'answerable'), (_, run) => isAnswered(run)),
    nearMissRefused: refused('near_miss'),
    outOfScopeRefused: refused('out_of_scope'),
    p0Forbidden: idsWith(
      item => item.priority === 'P0',
      (item, run) => item.forbidCards.includes(run.served)
    ),
    benignUrgent: idsWith(
      item => item.benignHowTo,
      (_, run) => urgent.has(run.served)
    ),
    helpAsIntent: idsWith(isHelp, (_, run) => INTENT_OPS.includes(run.op)),
    unknownIds: [...new Set(allRuns.flatMap(run => run.unknownIds))],
    unsupportedOnHelp: idsWith(isHelp, (_, run) => run.op === 'unsupported'),
    maxPromptTokens: Math.max(0, ...allRuns.map(run => run.promptTokens)) || null,
    requestErrors: idsWith(
      () => true,
      (_, run) => run.op === 'error'
    )
  };
}

const MIN_SHARES = {
  devAccepted: 0.95,
  holdoutAccepted: 0.9,
  answeredRate: 0.8,
  nearMissRefused: 0.85,
  outOfScopeRefused: 0.9
};
const MAX_PROMPT_TOKENS = 3600;

export function selectionFailures(score) {
  // The holdout and near-miss bars are judged on a holdout only.
  const holdoutOnly = ['holdoutAccepted', 'nearMissRefused'];
  const failures = Object.entries(MIN_SHARES)
    .filter(([name]) => score.holdoutAccepted !== null || !holdoutOnly.includes(name))
    .filter(([name, bar]) => !(score[name] >= bar))
    .map(([name, bar]) => `${name} ${score[name]} is under ${bar}`);
  for (const name of ['p0Forbidden', 'benignUrgent', 'helpAsIntent']) {
    if (score[name].length > 0) failures.push(`${name} ${score[name].join(', ')}`);
  }
  if (score.maxPromptTokens > MAX_PROMPT_TOKENS) {
    failures.push(`maxPromptTokens ${score.maxPromptTokens} is over ${MAX_PROMPT_TOKENS}`);
  }
  if (score.requestErrors.length > 0) failures.push(`requestErrors ${score.requestErrors.join(', ')}`);
  return failures;
}

/** The command gate: what got worse than the baseline run, plus the replies no run may give. */
export function compareCommands(cases, baseline, current) {
  const byId = summary => new Map(summary.results.map(result => [result.id, result]));
  const before = byId(baseline);
  const after = byId(current);
  return cases.flatMap(item => {
    const now = after.get(item.id);
    if (!now) return [`${item.id}: not run`];
    const was = before.get(item.id);
    const expected = [item.expected.op].flat();
    const failures = [];
    // A case added after the baseline has nothing to compare with, so it must pass on its own.
    const guarded = !was || was.passes === was.runs;
    if (!item.intendedChange && guarded && now.runs - now.passes >= 2) {
      const before = was ? `passed ${was.passes} of ${was.runs} on the baseline` : 'not on the baseline';
      failures.push(`${before}, now ${now.passes} of ${now.runs}`);
    }
    if (expected.includes('explain')) {
      const intent = now.ops.find(op => INTENT_OPS.includes(op));
      if (intent) failures.push(`a help question produced ${intent}`);
    } else if (now.ops.includes('explain')) {
      const what = item.category === 'fragment' ? 'a clarification reply' : 'a command';
      failures.push(`${what} was answered as help`);
    }
    return failures.map(failure => `${item.id}: ${failure}`);
  });
}

const HOLDOUT_PATH = path.join(__dirname, 'help-holdout.json');
const MIN_HOLDOUT_CLUSTERS = { answerable: 80, near_miss: 30, out_of_scope: 30 };
const CASE_CLASSES = ['answerable', 'near_miss', 'out_of_scope', 'action', 'fragment'];

// A cluster is scored once, so it must be one intent, never shared with the dev questions.
function selectionClusterErrors(dev, holdout) {
  const devClusters = new Set(dev.map(item => item.cluster));
  const reused = [...new Set(holdout.map(item => item.cluster))]
    .filter(name => name && devClusters.has(name))
    .map(name => `holdout reuses dev cluster ${name}`);
  const cases = [...dev, ...holdout];
  const merged = [...new Set(cases.map(item => item.cluster))].filter(Boolean).flatMap(name => {
    const [first, ...rest] = cases.filter(item => item.cluster === name);
    if (rest.some(item => item.class !== first.class)) return [`${name}: mixed class`];
    const shared = first.cards?.filter(id => rest.every(item => item.cards?.includes(id)));
    return first.class === 'answerable' && !shared?.length ? [`${name}: no shared accepted card`] : [];
  });
  return [...reused, ...merged];
}

// A mistyped id, card or class drops its case out of a bar without a word, so the run refuses it.
function selectionCaseErrors(cases) {
  const cards = new Set(helpDataset().cards.map(card => card.id));
  const topics = Object.keys(readJson('../../src/lib/command-ai/help-facts.json').topics);
  const seen = new Set();
  return cases.flatMap((item, index) => {
    const errors = ['id', 'cluster', 'q'].filter(key => !item[key]).map(key => `missing ${key}`);
    if (seen.has(item.id)) errors.push('repeated id');
    seen.add(item.id);
    if (!CASE_CLASSES.includes(item.class)) errors.push('bad class');
    if (!['P0', 'P1', 'P2'].includes(item.priority)) errors.push('bad priority');
    if (item.helpContext !== null && !topics.includes(item.helpContext)) errors.push('bad helpContext');
    for (const key of ['cards', 'forbidCards']) {
      if (!Array.isArray(item[key])) errors.push(`${key} must be a list`);
      else errors.push(...item[key].filter(id => !cards.has(id)).map(id => `unknown card ${id}`));
    }
    if ((item.class === 'answerable') !== item.cards?.length > 0) {
      errors.push('cards must be listed exactly for answerable cases');
    }
    if (item.priority === 'P0' && !item.forbidCards?.length) errors.push('a P0 case needs a forbidden card');
    return errors.map(error => `${item.id || `case ${index}`}: ${error}`);
  });
}

/** The selection questions. Only a dev run may go without the holdout, which tuning must never see. */
export function loadSelectionCases({ devOnly = false, holdoutPath = HOLDOUT_PATH } = {}) {
  const dev = readJson('help-eval.json');
  let holdout = [];
  if (!devOnly) {
    if (!existsSync(holdoutPath)) throw new Error('help-holdout.json is missing. Tune with --dev-only.');
    holdout = JSON.parse(readFileSync(holdoutPath, 'utf8'));
  }
  // Checked together, so a holdout id cannot repeat a dev id.
  const errors = [...selectionCaseErrors([...dev, ...holdout]), ...selectionClusterErrors(dev, holdout)];
  if (!devOnly) {
    for (const [name, minimum] of Object.entries(MIN_HOLDOUT_CLUSTERS)) {
      const count = new Set(holdout.filter(item => item.class === name).map(item => item.cluster)).size;
      if (count < minimum) errors.push(`holdout has ${count} ${name} clusters, needs ${minimum}`);
    }
  }
  if (errors.length > 0) throw new Error(`Bad selection cases:\n${errors.join('\n')}`);
  return [...dev, ...holdout.map(item => ({ ...item, set: 'holdout' }))];
}

const WRITING_HOLDOUT_PATH = path.join(__dirname, 'help-writing-holdout.json');

/** The written-answer questions: dev for tuning, else both holdouts, checked together with dev. */
export function loadWritingCases({
  devOnly = false,
  holdoutPath = HOLDOUT_PATH,
  writingHoldoutPath = WRITING_HOLDOUT_PATH
} = {}) {
  if (devOnly) return loadSelectionCases({ devOnly });
  const selection = loadSelectionCases({ holdoutPath }).filter(item => item.set === 'holdout');
  if (!existsSync(writingHoldoutPath)) throw new Error('help-writing-holdout.json is missing. Tune with --dev-only.');
  const written = JSON.parse(readFileSync(writingHoldoutPath, 'utf8'));
  const dev = readJson('help-eval.json');
  const all = [...dev, ...selection, ...written];
  const clusters = new Set(selection.map(item => item.cluster));
  const errors = [
    ...selectionCaseErrors(all),
    ...selectionClusterErrors(dev, written),
    ...[...new Set(written.map(item => item.cluster))]
      .filter(name => clusters.has(name))
      .map(name => `the writing holdout reuses selection holdout cluster ${name}`)
  ];
  if (errors.length > 0) throw new Error(`Bad writing cases:\n${errors.join('\n')}`);
  return [...selection, ...written.map(item => ({ ...item, set: 'holdout' }))];
}

const allWriting = data => ({
  ...data,
  writing: { ...data.writing, cards: data.cards.filter(card => card.mode === 'write').map(card => card.id) }
});
const noWriting = data => ({ ...data, writing: { ...data.writing, cards: [] } });

const TECHNICAL = ['writer_technical', 'checker_technical'];
const TECHNICAL_RERUNS = 3;

async function writingRun(compile, parse) {
  let technicalAttempts = 0;
  let run;
  do {
    try {
      const reply = await compile();
      const parsed = parse(reply.output);
      run = {
        op: parsed?.op ?? 'invalid',
        path: reply.trace?.path ?? null,
        served: reply.trace?.served ?? null,
        outcome: reply.trace?.writing?.outcome ?? null,
        cards: reply.trace?.writing?.cards ?? [],
        text: parsed?.op === 'explain' ? parsed.answer : JSON.stringify(reply.output)
      };
    } catch (error) {
      if (error?.quotaStop) throw error;
      run = { op: 'error', path: null, served: null, outcome: null, cards: [], text: '', error: error?.message };
    }
    if (!TECHNICAL.includes(run.outcome)) break;
    technicalAttempts += 1;
  } while (technicalAttempts <= TECHNICAL_RERUNS);
  return { ...run, technicalAttempts };
}

// A failed writer or checker answers with HTTP 200: scored, it would pass for a refusal or a fallback.
const isScorable = run => run.op !== 'error' && !TECHNICAL.includes(run.outcome);

/** The selection suite's Worker: writing off, so it measures the router's pick even after cards are listed. */
export const selectionWorker = (data = helpDataset()) => createEvalWorker({ dataset: noWriting(data), guard: true });

/** Each question `runs` times with every write card on. With `knockout`, its accepted cards leave the index. */
export async function runWriting({ cases, runs = 3, knockout = false, service = createEvalWorker({ guard: true }) }) {
  const { schemaMod, redactorMod } = loadAppModules();
  const written = allWriting(helpDataset());
  const budget = freshRetryBudget();
  const results = [];
  for (const item of cases) {
    const { redactedText } = redactorMod.redactPrompt(item.q, DEFAULT_CONTEXT);
    const dataset = knockout
      ? { ...written, cards: written.cards.filter(card => !item.cards.includes(card.id)) }
      : written;
    const result = { id: item.id, cluster: item.cluster, class: item.class, set: item.set ?? item.split, runs: [] };
    results.push(result);
    for (let attempt = 0; attempt < runs; attempt++) {
      result.runs.push(
        await writingRun(
          () =>
            retryTransient(() => service.compile({ redactedText, helpContext: item.helpContext }, { dataset }), budget),
          schemaMod.parseAiCompilerOutput
        )
      );
    }
  }
  return {
    results,
    invalid: results.filter(result => !result.runs.every(isScorable)).map(result => result.id)
  };
}

const knockoutCases = cases => cases.filter(item => item.class === 'answerable');
// A knockout run counts only if it reached the writer, and its refusals need no grade.
const isGraded = (run, knockout) => !knockout || (run.outcome !== null && run.path !== 'unknown');
const citedBy = run => (run.path === 'written' ? run.cards : run.served ? [run.served] : []);
const rowKey = row => JSON.stringify([row.cluster, row.q, row.previousTopic, row.text, row.path]);

function runRow(item, run) {
  return { cluster: item.cluster, q: item.q, previousTopic: item.helpContext, text: run.text, path: run.path };
}

/** What a person grades: each distinct text shown for a question, with the facts of the cards behind it. */
export function gradingRows(cases, results, { knockout = false } = {}) {
  const data = helpDataset();
  const byId = new Map(cases.map(item => [item.id, item]));
  const rows = new Map();
  for (const result of results) {
    const item = byId.get(result.id);
    for (const run of result.runs.filter(run => isGraded(run, knockout))) {
      const row = runRow(item, run);
      const cards = citedBy(run);
      const ids = data.cards
        .filter(card => cards.includes(card.id))
        .flatMap(card => [...card.lead, ...card.facts, ...card.limit]);
      const facts = [...new Set(ids)].map(id => data.facts[id].text);
      rows.set(rowKey(row), { ...row, cards, facts, verdict: null, serious: null });
    }
  }
  return [...rows.values()];
}

const BAD_CLASSES = [
  'flipped_not',
  'swapped_actor',
  'dropped_condition',
  'added_detail',
  'joined_facts',
  'neighbour_question',
  'forbidden_or_injected'
];
const MIN_CHECKER_ROWS = { bad: 150, perClass: 20, good: 75 };

export function checkerRowErrors(rows) {
  const cards = new Set(
    helpDataset()
      .cards.filter(card => card.mode === 'write')
      .map(card => card.id)
  );
  const seen = new Set();
  const errors = rows.flatMap((row, index) => {
    const bad = [];
    if (!row.id || seen.has(row.id)) bad.push('missing or repeated id');
    seen.add(row.id);
    if (![...BAD_CLASSES, 'good'].includes(row.class)) bad.push('bad class');
    if (!['P0', 'P1', 'P2'].includes(row.priority)) bad.push('bad priority');
    if (!(row.cards?.length >= 1 && row.cards.length <= 2 && row.cards.every(id => cards.has(id)))) {
      bad.push('needs one or two write cards');
    }
    if (!Array.isArray(row.sentences) || !row.q) bad.push('needs sentences and q');
    return bad.map(error => `${row.id || `row ${index}`}: ${error}`);
  });
  const count = test => rows.filter(test).length;
  const need = (name, found, minimum) => found < minimum && errors.push(`${found} ${name} rows, needs ${minimum}`);
  need(
    'bad',
    count(row => row.class !== 'good'),
    MIN_CHECKER_ROWS.bad
  );
  for (const name of BAD_CLASSES)
    need(
      name,
      count(row => row.class === name),
      MIN_CHECKER_ROWS.perClass
    );
  need(
    'good',
    count(row => row.class === 'good'),
    MIN_CHECKER_ROWS.good
  );
  return errors;
}

const checkerFile = devOnly => (devOnly ? 'writer-checks.json' : 'writer-checks-frozen.json');

export function loadCheckerRows({ devOnly = false } = {}) {
  const file = checkerFile(devOnly);
  if (!existsSync(path.join(__dirname, file))) throw new Error(`${file} is missing.`);
  const rows = readJson(file);
  const errors = checkerRowErrors(rows);
  if (errors.length > 0) throw new Error(`Bad checker rows:\n${errors.join('\n')}`);
  return rows;
}

/** Each fixed draft through the real gates once, and through the checker `runs` times, rejected ones too. */
export async function runWritingChecker({ rows, runs = 3, service = createEvalWorker({ guard: true }) }) {
  const { redactorMod } = loadAppModules();
  const { reviewDraft, writerInput, checkerInput, CHECKER_RULES } = loadHelpWrite();
  const { CHECKER, isVerdict } = loadWorker();
  const data = helpDataset();
  const results = [];
  const invalid = [];
  for (const row of rows) {
    const { redactedText } = redactorMod.redactPrompt(row.q, DEFAULT_CONTEXT);
    const cards = row.cards.map(id => data.cards.find(card => card.id === id));
    const input = writerInput(cards, data, redactedText, row.previousTopic);
    const draft = reviewDraft(
      { answerable: true, sentences: row.sentences },
      input,
      data,
      redactedText,
      row.previousTopic
    );
    const result = { id: row.id, class: row.class, priority: row.priority, gates: draft.kind === 'ok', runs: [] };
    results.push(result);
    for (let attempt = 0; attempt < runs; attempt++) {
      let verdict;
      let technicalAttempts = 0;
      while (technicalAttempts <= TECHNICAL_RERUNS) {
        verdict = await service.call({
          model: data.writing.checker,
          system: CHECKER_RULES,
          user: checkerInput(row.sentences, input, data, redactedText, row.previousTopic),
          name: CHECKER.name,
          schema: CHECKER.schema,
          maxTokens: CHECKER.maxTokens,
          timeoutMs: CHECKER.timeoutMs
        });
        if (isVerdict(verdict)) break;
        technicalAttempts += 1;
      }
      // A rate-limited checker would otherwise reject every bad answer.
      if (!isVerdict(verdict)) invalid.push(row.id);
      result.runs.push({
        accepted: isVerdict(verdict) ? verdict.supported && verdict.answers : null,
        technicalAttempts
      });
    }
  }
  return { results, invalid: [...new Set(invalid)] };
}

const share = (items, test) => (items.length === 0 ? null : items.filter(test).length / items.length);

export function scoreWritingChecker(results) {
  const bad = results.filter(row => row.class !== 'good');
  const good = results.filter(row => row.class === 'good');
  // A bad draft is accepted if any checker run accepts it, a faithful one rejected if any run rejects it.
  const someAccept = row => row.runs.some(run => run.accepted === true);
  const someReject = row => row.runs.some(run => run.accepted !== true);
  return {
    p0Accepted: bad.filter(row => row.priority === 'P0' && row.gates && someAccept(row)).map(row => row.id),
    badAccepted: share(bad, row => row.gates && someAccept(row)),
    badPassingGates: share(bad, row => row.gates),
    badPassingChecker: share(bad, someAccept),
    goodRejected: share(good, row => !row.gates || someReject(row)),
    goodRejectedGates: share(good, row => !row.gates),
    goodRejectedChecker: share(good, someReject)
  };
}

export function checkerFailures(score) {
  const failures = [];
  if (score.p0Accepted.length > 0) failures.push(`P0 bad answers accepted: ${score.p0Accepted.join(', ')}`);
  if (!(score.badAccepted !== null && score.badAccepted <= 0.02)) {
    failures.push(`badAccepted ${score.badAccepted} is over 0.02`);
  }
  if (!(score.goodRejected !== null && score.goodRejected <= 0.15)) {
    failures.push(`goodRejected ${score.goodRejected} is over 0.15`);
  }
  return failures;
}

export function wilsonLower(correct, total, z = 1.96) {
  if (total === 0) return 0;
  const p = correct / total;
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return (p + (z * z) / (2 * total) - spread) / (1 + (z * z) / total);
}

const MIN_WRITTEN_CLUSTERS = 150;
const MIN_KNOCKOUT_CLUSTERS = 30;
const MIN_CARD_CLUSTERS = 3;
const MAX_TECHNICAL = 0.02;
const MAX_FALLBACK = 0.15;

const HASHED = [
  'services/command-ai/src/help-cards.json',
  'services/command-ai/src/index.ts',
  'services/command-ai/src/help.ts',
  'services/command-ai/src/help-write.ts',
  'services/command-ai/src/help-safety.mjs',
  'scripts/command-ai-eval/run-eval.mjs',
  'scripts/command-ai-eval/eval-context.json',
  'scripts/command-ai-eval/help-eval.json',
  'scripts/command-ai-eval/help-holdout.json',
  'scripts/command-ai-eval/help-writing-holdout.json',
  'scripts/command-ai-eval/writer-checks.json',
  'scripts/command-ai-eval/writer-checks-frozen.json'
];

/** What ties a summary to the code and questions that produced it. */
export function evalMeta({ suite, devOnly = false }) {
  const hash = file => {
    const full = path.join(ROOT, file);
    return existsSync(full) ? createHash('sha256').update(readFileSync(full)).digest('hex') : null;
  };
  const { writing } = helpDataset();
  return {
    suite,
    devOnly,
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    hashes: Object.fromEntries(HASHED.map(file => [file, hash(file)])),
    models: { router: DEFAULT_EVAL_MODEL(), writer: writing.writer, checker: writing.checker }
  };
}

const SCORED_SUITES = {
  selection: 'selection',
  checker: 'writing-checker',
  writing: 'writing',
  knockout: 'writing-knockout'
};

function complete(name, results, expected, runs = 3) {
  const found = new Map(results.map(result => [result.id, result]));
  const missing = expected.filter(item => found.get(item.id)?.runs.length !== runs);
  if (missing.length > 0 || results.length !== expected.length) {
    throw new Error(`${name} lacks full runs: ${missing.length} of ${expected.length} cases`);
  }
}

function verdicts(name, rows, expected) {
  const graded = new Map();
  for (const row of rows) {
    if (!['correct', 'wrong'].includes(row.verdict) || typeof row.serious !== 'boolean') {
      throw new Error(`${name} has an ungraded row: ${row.cluster}`);
    }
    if (graded.has(rowKey(row))) throw new Error(`${name} grades a row twice: ${row.cluster}`);
    graded.set(rowKey(row), row);
  }
  const wanted = expected.map(rowKey);
  if (wanted.length !== graded.size || !wanted.every(key => graded.has(key))) {
    throw new Error(`${name} does not match its summary: ${graded.size} rows, ${wanted.length} expected`);
  }
  return graded;
}

/**
 * The enable decision, from four summaries of one commit and the two graded files. Throws on anything it cannot
 * score; `failures` is empty only when every bar passes, and `allowlist` is then what `writing.cards` may list.
 */
export function scoreWriting({ summaries, grading, knockoutGrading, cases }) {
  const metas = Object.entries(SCORED_SUITES).map(([key, suite]) => {
    const meta = summaries[key]?.meta;
    if (meta?.suite !== suite || meta.devOnly) throw new Error(`${key} is not a full ${suite} summary`);
    if (summaries[key].invalid?.length > 0) throw new Error(`${key} is invalid: technical failures remain`);
    return JSON.stringify([meta.gitSha, meta.hashes, meta.models]);
  });
  if (new Set(metas).size !== 1) throw new Error('The summaries come from different code, questions or models');
  const knockedOut = knockoutCases(cases.writing);
  complete('selection', summaries.selection.results, cases.selection);
  complete('writing', summaries.writing.results, cases.writing);
  complete('knockout', summaries.knockout.results, knockedOut);
  complete('checker', summaries.checker.results, cases.checker);
  for (const key of ['writing', 'knockout']) {
    if (!summaries[key].results.every(result => result.runs.every(isScorable))) {
      throw new Error(`${key} holds failed runs`);
    }
  }
  const graded = verdicts('writing grading', grading, gradingRows(cases.writing, summaries.writing.results));
  const gradedKnockout = verdicts(
    'knockout grading',
    knockoutGrading,
    gradingRows(knockedOut, summaries.knockout.results, { knockout: true })
  );

  const failures = [
    ...selectionFailures(scoreSelection(summaries.selection.results)).map(failure => `selection: ${failure}`),
    ...checkerFailures(scoreWritingChecker(summaries.checker.results)).map(failure => `checker: ${failure}`)
  ];
  const serious = [...graded.values(), ...gradedKnockout.values()].filter(row => row.serious);
  if (serious.length > 0) failures.push(`serious errors: ${serious.map(row => row.cluster).join(', ')}`);

  const byId = new Map(cases.writing.map(item => [item.id, item]));
  const runs = summaries.writing.results.flatMap(result =>
    result.runs.map(run => {
      const item = byId.get(result.id);
      return { ...run, cluster: result.cluster, class: result.class, row: graded.get(rowKey(runRow(item, run))) };
    })
  );
  const clusters = list => [...new Set(list.map(run => run.cluster))];
  // A cluster counts once, and is right only if every run counted is.
  const clusterRate = (list, test) => {
    const names = clusters(list);
    return share(names, name => list.filter(run => run.cluster === name).every(test));
  };
  const isRight = run => run.row.verdict === 'correct';
  const bar = (name, value, minimum) => {
    if (!(value !== null && value >= minimum)) failures.push(`${name} ${value} is under ${minimum}`);
  };

  const written = runs.filter(run => run.path === 'written');
  const writtenClusters = clusters(written).length;
  const writtenCorrect = clusterRate(written, isRight);
  const writtenLower = wilsonLower(Math.round((writtenCorrect ?? 0) * writtenClusters), writtenClusters);
  bar('written clusters', writtenClusters, MIN_WRITTEN_CLUSTERS);
  bar('written precision', writtenCorrect, 0.95);
  bar('written Wilson lower bound', writtenLower, 0.9);

  const answerable = runs.filter(run => run.class === 'answerable');
  const isAnsweredPath = run => run.path === 'written' || run.path === 'card';
  const allPaths = clusterRate(answerable.filter(isAnsweredPath), isRight);
  const answeredRate = clusterRate(answerable, isAnsweredPath);
  const refused = name =>
    clusterRate(
      runs.filter(run => run.class === name),
      run => run.path === 'unknown'
    );
  const nearMissRefused = refused('near_miss');
  const outOfScopeRefused = refused('out_of_scope');
  bar('all-paths precision', allPaths, 0.95);
  bar('answeredRate', answeredRate, 0.8);
  bar('nearMissRefused', nearMissRefused, 0.85);
  bar('outOfScopeRefused', outOfScopeRefused, 0.9);

  const knockoutById = new Map(knockedOut.map(item => [item.id, item]));
  const counted = summaries.knockout.results.flatMap(result =>
    result.runs
      .filter(run => run.outcome !== null)
      .map(run => ({
        ...run,
        cluster: result.cluster,
        row: gradedKnockout.get(rowKey(runRow(knockoutById.get(result.id), run)))
      }))
  );
  const knockoutPass = share(counted, run => run.path === 'unknown' || isRight(run));
  if (clusters(counted).length < MIN_KNOCKOUT_CLUSTERS) {
    failures.push(`knockout reached the writer in ${clusters(counted).length} clusters: no verdict`);
  }
  bar('knockout pass', knockoutPass, 0.95);

  const eligible = runs.filter(run => run.outcome !== null);
  const technical = {};
  for (const [name, list] of [
    ['writing', eligible],
    ['knockout', counted]
  ]) {
    technical[name] = share(list, run => run.technicalAttempts > 0);
    if (!(technical[name] !== null && technical[name] <= MAX_TECHNICAL)) {
      failures.push(`void: ${name} technical failures on first attempts ${technical[name]}`);
    }
  }
  const fallbacks = eligible.filter(run => run.path === 'card');
  const fallbackShare = share(eligible, run => run.path === 'card');
  if (!(fallbackShare !== null && fallbackShare <= MAX_FALLBACK)) {
    failures.push(`checked-answer fallbacks ${fallbackShare} are over ${MAX_FALLBACK}`);
  }
  const rate = list => ({ runs: list.length, precision: clusterRate(list, isRight) });
  const fallbackRows = Object.fromEntries(
    [...new Set(fallbacks.map(run => run.outcome))].map(event => [
      event,
      rate(fallbacks.filter(run => run.outcome === event))
    ])
  );
  for (const [event, row] of Object.entries(fallbackRows)) {
    if (row.precision < 0.95) {
      failures.push(`the ${event} fallback is ${row.precision} precise: it must say it does not know`);
    }
  }

  const data = helpDataset();
  const modeOf = new Map(data.cards.map(card => [card.id, card.mode]));
  const checkedAnswers = mode =>
    rate(runs.filter(run => run.path === 'card' && run.outcome === null && modeOf.get(run.served) === mode));
  const cards = Object.fromEntries(
    data.cards
      .filter(card => card.mode === 'write')
      .map(card => {
        const own = written.filter(run => run.cards.includes(card.id));
        const wrong = clusters(own.filter(run => !isRight(run))).length;
        const row = { clusters: clusters(own).length, wrong, serious: own.some(run => run.row.serious) };
        return [card.id, row];
      })
  );
  const allowlist = Object.entries(cards)
    .filter(([, row]) => row.clusters >= MIN_CARD_CLUSTERS && !row.serious && row.wrong < 2)
    .map(([id]) => id);

  return {
    failures,
    report: {
      writtenClusters,
      writtenCorrect,
      writtenLower,
      allPaths,
      answeredRate,
      nearMissRefused,
      outOfScopeRefused,
      knockoutPass,
      knockoutClusters: clusters(counted).length,
      technical,
      fallbackShare,
      fallbackRows,
      fixed: checkedAnswers('fixed'),
      checked: checkedAnswers('checked'),
      written: rate(written),
      cards
    },
    allowlist
  };
}

const MEASURE_ATTEMPTS = 3;
const MEASURE_SMALL_CALLS = 5;
const MEASURE_TIMEOUT_MS = 20000;
// The router's completion cap, which the provider may hold against the bucket until the reply is counted.
const ROUTER_OUTPUT_CAP = 512;

/**
 * One call of each kind, then the proof that the writer and checker have their own quota: five of their calls
 * between two router calls must move neither the router's daily requests nor its tokens. Run it unpaced.
 */
export async function runMeasure({ service = createEvalWorker({ paced: false }) } = {}) {
  const { writerInput, checkerInput, CHECKER_RULES } = loadHelpWrite();
  const { WRITER, CHECKER, isVerdict } = loadWorker();
  const data = helpDataset();
  const { writer, checker } = data.writing;
  const card = data.cards.find(item => item.id === 'guardian_what');
  const question = 'what is a guardian';
  const failures = [];

  const routerCall = async () => {
    try {
      await service.compile({ redactedText: question, helpContext: null });
    } catch (error) {
      failures.push(`the router call failed: ${error?.message}`);
    }
    return service.stats.last[service.model];
  };
  const input = writerInput([card], data, question, null);
  const sentences = [{ facts: [card.facts[0]], text: data.facts[card.facts[0]].text }];
  const smallCall = (role, model, system, user) =>
    service.call({
      model,
      system,
      user,
      name: role.name,
      schema: role.schema,
      maxTokens: role.maxTokens,
      timeoutMs: MEASURE_TIMEOUT_MS
    });
  const writerCall = () => smallCall(WRITER, writer, input.system, input.user);

  const router = await routerCall();
  if (router.promptTokens > MAX_PROMPT_TOKENS) {
    failures.push(`the router prompt is ${router.promptTokens} tokens, over ${MAX_PROMPT_TOKENS}`);
  }
  const record = (name, model, accepted) => {
    const last = service.stats.last[model];
    if (!accepted) failures.push(`the ${name} call failed with HTTP ${last?.status}`);
    return last;
  };
  const written = record('writer', writer, (await writerCall()) !== undefined);
  const verdict = await smallCall(
    CHECKER,
    checker,
    CHECKER_RULES,
    checkerInput(sentences, input, data, question, null)
  );
  const checked = record('checker', checker, isVerdict(verdict));

  const smallTokens = () => {
    const usage = service.stats.models[writer];
    return usage.promptTokens + usage.completionTokens;
  };
  const attempts = [];
  let proven = false;
  while (!proven && attempts.length < MEASURE_ATTEMPTS) {
    const before = await routerCall();
    const spentBefore = smallTokens();
    await Promise.all(Array.from({ length: MEASURE_SMALL_CALLS }, writerCall));
    const spent = smallTokens() - spentBefore;
    const after = await routerCall();
    const read = (reply, name) => Number(reply.headers[`x-ratelimit-${name}`] ?? Number.NaN);
    const elapsedMs = after.respondedAt - before.respondedAt;
    const attempt = {
      requestsApart: Math.abs(read(before, 'remaining-requests') - read(after, 'remaining-requests')),
      tokenDrop: read(before, 'remaining-tokens') - read(after, 'remaining-tokens'),
      reservation: after.promptTokens + ROUTER_OUTPUT_CAP,
      smallTokens: spent,
      refill: (read(after, 'limit-tokens') / 60) * (elapsedMs / 1000),
      elapsedMs
    };
    // Daily requests refill slowly. The tokens tell only if a shared bucket's drop could not hide in the refill.
    proven =
      attempt.requestsApart <= 1 &&
      attempt.smallTokens > attempt.reservation + attempt.refill &&
      attempt.tokenDrop <= attempt.reservation;
    attempts.push(attempt);
  }
  if (!proven) failures.push('no proof that the writer and checker leave the router quota alone');

  return { router, writer: written, checker: checked, separation: { proven, attempts }, failures };
}

const GATE_HELP_ACCURACY = 0.9;
const MIN_WRITER_QUESTIONS = 6;

function matchesExpected(parsed, expected) {
  const ticker = value => (value ?? '').toUpperCase().replace(/[<>]/g, '');
  return (
    [expected.op].flat().includes(parsed.op) &&
    (!expected.action || parsed.action === expected.action) &&
    (!expected.asset || ticker(parsed.asset) === expected.asset.toUpperCase()) &&
    (!expected.to_asset || ticker(parsed.to_asset) === expected.to_asset.toUpperCase()) &&
    (!expected.query || parsed.query === expected.query) &&
    (!expected.earn_op || parsed.earn_op === expected.earn_op) &&
    (expected.amountKind === undefined ||
      (expected.amountKind === null ? parsed.amount === null : parsed.amount?.kind === expected.amountKind))
  );
}

export async function runEval({
  offlineOnly = true,
  questions = false,
  commandsViaWorker = false,
  runs = commandsViaWorker || questions ? 3 : 1,
  model = DEFAULT_EVAL_MODEL(),
  dataset,
  guard = false
} = {}) {
  const { schemaMod, redactorMod } = loadAppModules();
  const cases = readJson(questions ? 'questions.json' : 'cases.json');
  const cards = new Map((dataset ?? helpDataset()).cards.map(card => [card.id, card]));
  const globalForbid = (dataset ?? helpDataset()).forbid;
  const gateFailures = new Set();
  let helpTotal = 0;
  let helpPassed = 0;
  const listed = (dataset ?? helpDataset()).writing.cards;
  const writerQuestions = new Set();
  const writtenQuestions = new Set();
  let redactionFailures = 0;
  let provenanceFailures = 0;
  let obligationFailures = 0;
  let modelFailures = 0;
  const errors = [];
  const latencies = [];
  let maxPromptTokens = 0;
  const results = [];
  const retryBudget = freshRetryBudget();
  const viaWorker = questions || commandsViaWorker;
  const proxyMod =
    offlineOnly || viaWorker ? null : await import(path.join(ROOT, 'services/command-ai-proxy/server.mjs'));
  const worker = offlineOnly || !viaWorker ? null : createEvalWorker({ model, dataset, guard });

  const retryCompile = compile => retryTransient(compile, worker ? retryBudget : undefined);

  for (const testCase of cases) {
    const redaction = redactorMod.redactPrompt(testCase.prompt, DEFAULT_CONTEXT);
    if (redaction.redactedText !== testCase.expectedRedacted) {
      redactionFailures += 1;
      errors.push(
        `[REDACT FAIL] ${testCase.id}: got ${JSON.stringify(redaction.redactedText)}, want ${JSON.stringify(testCase.expectedRedacted)}`
      );
    }
    for (const forbidden of testCase.forbiddenSubstrings ?? []) {
      if (redaction.redactedText.toLowerCase().includes(forbidden.toLowerCase())) {
        redactionFailures += 1;
        errors.push(
          `[LEAK FAIL] ${testCase.id}: leaked ${JSON.stringify(forbidden)} in ${JSON.stringify(redaction.redactedText)}`
        );
      }
    }

    const spoofed = {
      op: 'set_intent',
      action: 'send',
      amount: { kind: 'exact_ref', ref: 'AMT_999' },
      asset: 'ETH',
      to_asset: null,
      from_chain: null,
      to_chain: null,
      recipient_ref: 'ADDR_999',
      provider: null,
      note_type: null,
      earn_op: null
    };
    if (redactorMod.verifyProvenance(spoofed, redaction.map) !== false) {
      provenanceFailures += 1;
      errors.push(`[PROVENANCE FAIL] ${testCase.id}: accepted hallucinated refs`);
    }

    const isHelp = Array.isArray(testCase.cards);
    if (questions) {
      // A help question names its accepted cards, and a P0 one the cards that must never answer it.
      const declared = isHelp
        ? [...testCase.cards, ...(testCase.forbidCards ?? [])].every(id => cards.has(id)) &&
          (testCase.priority !== 'P0' || testCase.forbidCards?.length > 0)
        : Boolean(testCase.expected?.op);
      if (!declared) {
        obligationFailures += 1;
        errors.push(`[OBLIGATION FAIL] ${testCase.id}: names no valid expected cards, forbidden cards or op`);
        continue;
      }
    }

    if (worker || proxyMod) {
      const result = { id: testCase.id, passes: 0, runs, ops: [], ...(questions ? { served: [] } : {}) };
      results.push(result);
      const block = reason => gateFailures.add(`${testCase.id}: ${reason}`);
      let attempts = 0;
      let misses = 0;
      while (attempts < runs) {
        const attempt = attempts++;
        const t0 = Date.now();
        const pacedBefore = worker?.stats.pacedMs ?? 0;
        try {
          const res = await retryCompile(() =>
            worker
              ? worker.compile({
                  redactedText: redaction.redactedText,
                  // The app sends a help context with every first message and none with a snapshot.
                  ...(testCase.snapshot
                    ? { snapshot: testCase.snapshot }
                    : { helpContext: testCase.helpContext ?? null })
                })
              : proxyMod.compileWithGroq({
                  redactedText: redaction.redactedText,
                  snapshot: testCase.snapshot,
                  apiKey: process.env.GROQ_API_KEY,
                  model
                })
          );
          latencies.push(Date.now() - t0 - ((worker?.stats.pacedMs ?? 0) - pacedBefore));
          maxPromptTokens = Math.max(maxPromptTokens, res.usage?.prompt_tokens ?? 0);
          const parsed = schemaMod.parseAiCompilerOutput(res.output);
          const served = res.trace?.served ?? null;
          if (questions && testCase.cards?.some(id => listed.includes(id))) {
            writerQuestions.add(testCase.id);
            if (res.trace?.path === 'written') writtenQuestions.add(testCase.id);
          }
          result.ops.push(parsed?.op ?? 'invalid');
          if (questions) {
            result.served.push(served);
            const forbid = [...globalForbid, ...(cards.get(served)?.forbid ?? [])];
            if (!parsed) block('reply failed the app parser');
            else if (parsed.op === 'explain' && forbid.some(pattern => new RegExp(pattern, 'i').test(parsed.answer))) {
              block('reply hit a forbidden pattern');
            }
            if (isHelp && INTENT_OPS.includes(parsed?.op)) block(`a help question produced ${parsed.op}`);
            if (isHelp && testCase.priority === 'P0' && testCase.forbidCards.includes(served)) {
              block(`served the forbidden card ${served}`);
            }
          }
          if (!parsed || !redactorMod.verifyProvenance(parsed, redaction.map)) {
            misses += 1;
            errors.push(`[MODEL SCHEMA/PROV FAIL] ${testCase.id}: ${JSON.stringify(res.output)}`);
          } else if (questions && isHelp) {
            const accepted = testCase.cards.length > 0 ? testCase.cards : UNKNOWN_CARDS;
            if (accepted.includes(served)) {
              result.passes += 1;
            } else {
              misses += 1;
              errors.push(`[MODEL ACCURACY FAIL] ${testCase.id}: served ${served}, accepted ${accepted.join(', ')}`);
            }
          } else if (matchesExpected(parsed, testCase.expected)) {
            result.passes += 1;
          } else {
            misses += 1;
            errors.push(
              `[MODEL ACCURACY FAIL] ${testCase.id}: got ${JSON.stringify(parsed)}, expected subset ${JSON.stringify(testCase.expected)}`
            );
          }
        } catch (err) {
          if (err?.quotaStop) throw err;
          if (result.ops.length === attempt) {
            result.ops.push('error');
            result.served?.push(null);
          }
          misses += 1;
          errors.push(`[MODEL ERR] ${testCase.id}: ${err?.message || err}`);
        }
        // The gate asks a question twice more only after a miss.
        if (questions && attempts === 1 && misses === 0) break;
      }
      if (!questions) {
        modelFailures += misses;
        continue;
      }
      result.runs = attempts;
      const passed = misses === 0 || result.passes >= 2;
      if (!passed) modelFailures += 1;
      if (isHelp) {
        helpTotal += 1;
        if (passed) helpPassed += 1;
      } else if (!passed) {
        block('control failed');
      }
    }
  }

  const helpAccuracy = helpTotal === 0 ? null : helpPassed / helpTotal;
  if (helpAccuracy !== null && helpAccuracy < GATE_HELP_ACCURACY) {
    gateFailures.add(`help card accuracy ${helpAccuracy.toFixed(2)} is under ${GATE_HELP_ACCURACY}`);
  }

  // A failed writer still serves a right checked answer, so accuracy alone would deploy writing that never writes.
  if (questions && worker && listed.length > 0) {
    if (writerQuestions.size < MIN_WRITER_QUESTIONS) {
      gateFailures.add(`${writerQuestions.size} questions expect a listed writing card, needs ${MIN_WRITER_QUESTIONS}`);
    } else if (writtenQuestions.size * 3 < writerQuestions.size * 2) {
      gateFailures.add(
        `only ${writtenQuestions.size} of ${writerQuestions.size} writer questions were answered in written text`
      );
    }
  }

  return {
    mode: offlineOnly ? 'offline' : `live:${model}`,
    totalCases: cases.length,
    results,
    redactionFailures,
    provenanceFailures,
    obligationFailures,
    modelFailures,
    ...(questions && worker ? { gate: { helpAccuracy, failures: [...gateFailures] } } : {}),
    maxPromptTokens: Math.max(maxPromptTokens, worker?.stats.maxPromptTokens ?? 0) || null,
    rateLimitHeaders: worker?.stats.rateLimitHeaders ?? null,
    errors,
    p95LatencyMs:
      latencies.length > 0
        ? [...latencies].sort((a, b) => a - b)[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
        : null
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--require-live') && !process.env.GROQ_API_KEY?.trim()) {
    throw new Error('The live evaluation requires its model credential.');
  }
  const offlineOnly = process.argv.includes('--offline') || !process.env.GROQ_API_KEY;
  const questions = process.argv.includes('--questions');
  const summaryPath = process.env.COMMAND_AI_EVAL_SUMMARY;
  // stdout also carries the Worker's log lines, so the artifact is written separately.
  const writeSummary = summary => summaryPath && writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  const devOnly = process.argv.includes('--dev-only');
  const writeGrading = rows =>
    summaryPath && writeFileSync(path.join(path.dirname(summaryPath), 'grading.json'), JSON.stringify(rows, null, 2));
  const live = () => {
    if (offlineOnly) throw new Error('This run needs a model credential.');
    return createEvalWorker({ guard: true });
  };
  let failed;
  const scoreAt = process.argv.indexOf('--writing-score');
  if (process.argv.includes('--measure')) {
    if (offlineOnly) throw new Error('This run needs a model credential.');
    // Neither paced nor guarded: it is what shows whether any other suite may run.
    const report = { meta: evalMeta({ suite: 'measure' }), ...(await runMeasure()) };
    writeSummary(report);
    console.log(JSON.stringify(report, null, 2));
    failed = report.failures.length > 0;
  } else if (scoreAt > 0) {
    const read = name => JSON.parse(readFileSync(path.join(process.argv[scoreAt + 1], `${name}.json`), 'utf8'));
    const summaries = Object.fromEntries(Object.entries(SCORED_SUITES).map(([key, name]) => [key, read(name)]));
    // A results commit changes no hashed file, so the summaries must still match this checkout.
    const current = JSON.stringify(evalMeta({ suite: 'writing' }).hashes);
    if (JSON.stringify(summaries.writing.meta?.hashes) !== current) {
      throw new Error('The summaries do not match the checked-out code and questions.');
    }
    const score = scoreWriting({
      summaries,
      grading: read('writing-grading'),
      knockoutGrading: read('writing-knockout-grading'),
      cases: { selection: loadSelectionCases(), writing: loadWritingCases(), checker: loadCheckerRows() }
    });
    writeSummary(score);
    console.log(JSON.stringify(score, null, 2));
    failed = score.failures.length > 0;
  } else if (process.argv.includes('--writing-checker')) {
    const service = live();
    const meta = evalMeta({ suite: 'writing-checker', devOnly });
    const { results, invalid } = await runWritingChecker({ rows: loadCheckerRows({ devOnly }), service });
    const score = scoreWritingChecker(results);
    const failures = checkerFailures(score);
    writeSummary({ meta, score, failures, invalid, usage: service.stats.models, results });
    console.log(JSON.stringify({ score, failures, invalid }, null, 2));
    failed = failures.length > 0 || invalid.length > 0;
  } else if (process.argv.includes('--writing') || process.argv.includes('--writing-knockout')) {
    const knockout = process.argv.includes('--writing-knockout');
    const service = live();
    const meta = evalMeta({ suite: knockout ? 'writing-knockout' : 'writing', devOnly });
    const loaded = loadWritingCases({ devOnly });
    const cases = knockout ? knockoutCases(loaded) : loaded;
    const { results, invalid } = await runWriting({ cases, knockout, service });
    const reached = results.filter(result => result.runs.some(run => run.outcome !== null));
    const counted = new Set(reached.map(result => result.cluster)).size;
    writeSummary({ meta, invalid, countedClusters: counted, usage: service.stats.models, results });
    const grading = gradingRows(cases, results, { knockout });
    writeGrading(grading);
    console.log(JSON.stringify({ invalid, countedClusters: counted, gradingRows: grading.length }, null, 2));
    if (knockout && counted < MIN_KNOCKOUT_CLUSTERS) {
      console.error(`Only ${counted} clusters reached the writer: no verdict.`);
    }
    failed = invalid.length > 0 || (knockout && !devOnly && counted < MIN_KNOCKOUT_CLUSTERS);
  } else if (process.argv.includes('--selection')) {
    if (offlineOnly) throw new Error('The selection run needs a model credential.');
    const meta = evalMeta({ suite: 'selection', devOnly });
    const cases = loadSelectionCases({ devOnly });
    const service = selectionWorker();
    const results = await runSelection({ cases, service });
    const score = scoreSelection(results);
    const failures = selectionFailures(score);
    writeSummary({ meta, score, failures, rateLimitHeaders: service.stats.rateLimitHeaders, results });
    console.log(JSON.stringify({ score, failures }, null, 2));
    failed = failures.length > 0;
  } else {
    const commandsViaWorker = process.argv.includes('--commands');
    // The deploy gate asks a few dozen questions; a whole suite also protects the account's quota.
    const summary = await runEval({ offlineOnly, questions, commandsViaWorker, guard: commandsViaWorker });
    const compareAt = process.argv.indexOf('--compare');
    if (compareAt > 0) {
      const baseline = JSON.parse(readFileSync(process.argv[compareAt + 1], 'utf8'));
      summary.compareFailures = compareCommands(readJson('cases.json'), baseline, summary);
    }
    writeSummary(commandsViaWorker ? { meta: evalMeta({ suite: 'commands' }), ...summary } : summary);
    for (const err of summary.errors) console.error(err);
    console.log(JSON.stringify({ ...summary, errors: undefined, results: undefined }, null, 2));
    // The deploy gate and the baseline comparison allow some model misses, and decide for themselves.
    const modelFailed = summary.gate
      ? summary.gate.failures.length > 0
      : summary.compareFailures
        ? summary.compareFailures.length > 0
        : summary.modelFailures > 0;
    failed =
      summary.redactionFailures > 0 || summary.provenanceFailures > 0 || summary.obligationFailures > 0 || modelFailed;
  }
  if (failed) {
    process.exit(1);
  }
}
