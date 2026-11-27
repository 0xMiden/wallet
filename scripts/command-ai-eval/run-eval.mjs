import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

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
  if (remaining === null || Number(remaining) >= lastPromptTokens + PACE_TOKEN_MARGIN) return 0;
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

/** The real Worker with paced provider calls. `compile` also returns the Worker's help trace. */
export function createEvalWorker({ model = DEFAULT_EVAL_MODEL(), dataset } = {}) {
  const stats = { maxPromptTokens: 0, promptTokens: 0, rateLimitHeaders: null, pacedMs: 0 };
  let providerFailureDetail;
  let trace;
  const service = loadTsModule('services/command-ai/src/index.ts').createService({
    dataset,
    onTrace: value => {
      trace = value;
    },
    fetchImpl: async (...args) => {
      providerFailureDetail = undefined;
      const response = await fetch(...args);
      const body = await response.text();
      let data = null;
      try {
        data = JSON.parse(body);
      } catch {}
      stats.promptTokens = data?.usage?.prompt_tokens ?? 0;
      stats.maxPromptTokens = Math.max(stats.maxPromptTokens, stats.promptTokens);
      const limits = [...response.headers].filter(([name]) => name.startsWith('x-ratelimit-'));
      if (limits.length > 0) stats.rateLimitHeaders = Object.fromEntries(limits);
      const finishReason = data?.choices?.[0]?.finish_reason;
      providerFailureDetail = !response.ok
        ? `provider HTTP ${response.status}`
        : ['stop', 'length', 'content_filter', 'tool_calls'].includes(finishReason)
          ? `provider finish ${finishReason}`
          : undefined;
      // A 429 is waited for once, by retryTransient, which charges that wait to the retry budget.
      const delayMs = response.status === 429 ? 0 : paceDelayMs(response.headers, stats.promptTokens);
      if (delayMs > 0) {
        stats.pacedMs += delayMs;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      // Rebuilt because the sleep can outlast the Worker's abort timer, which would break the original body.
      return new Response(response.status === 204 ? null : body, {
        status: response.status,
        headers: response.headers
      });
    }
  });

  async function compile(body) {
    providerFailureDetail = undefined;
    trace = undefined;
    stats.promptTokens = 0;
    const response = await service.fetch(
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

  return { stats, compile };
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

const GATE_HELP_ACCURACY = 0.9;

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
  dataset
} = {}) {
  const { schemaMod, redactorMod } = loadAppModules();
  const cases = readJson(questions ? 'questions.json' : 'cases.json');
  const cards = new Map((dataset ?? helpDataset()).cards.map(card => [card.id, card]));
  const globalForbid = (dataset ?? helpDataset()).forbid;
  const gateFailures = new Set();
  let helpTotal = 0;
  let helpPassed = 0;
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
  const worker = offlineOnly || !viaWorker ? null : createEvalWorker({ model, dataset });

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
  let failed;
  if (process.argv.includes('--selection')) {
    if (offlineOnly) throw new Error('The selection run needs a model credential.');
    const cases = loadSelectionCases({ devOnly: process.argv.includes('--dev-only') });
    const service = createEvalWorker();
    const results = await runSelection({ cases, service });
    const score = scoreSelection(results);
    const failures = selectionFailures(score);
    writeSummary({ score, failures, rateLimitHeaders: service.stats.rateLimitHeaders, results });
    console.log(JSON.stringify({ score, failures }, null, 2));
    failed = failures.length > 0;
  } else {
    const commandsViaWorker = process.argv.includes('--commands');
    const summary = await runEval({ offlineOnly, questions, commandsViaWorker });
    const compareAt = process.argv.indexOf('--compare');
    if (compareAt > 0) {
      const baseline = JSON.parse(readFileSync(process.argv[compareAt + 1], 'utf8'));
      summary.compareFailures = compareCommands(readJson('cases.json'), baseline, summary);
    }
    writeSummary(summary);
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
