import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { hasUnsafeSharingAdvice } from '../../services/command-ai/src/help-safety.mjs';

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
  // Live traffic shares the account, so a suite never takes more than half of the bucket.
  const half = Number(headers.get('x-ratelimit-limit-tokens') ?? 0) / 2;
  if (remaining === null || Number(remaining) >= Math.max(half, lastPromptTokens + PACE_TOKEN_MARGIN)) return 0;
  return parseResetMs(headers.get('x-ratelimit-reset-tokens') ?? '');
}

/** A 429 may be waited out only when it names a per-minute limit and asks for at most 5 minutes. Never echoes the body. */
export function hardLimitReason(headers, body) {
  const header = headers.get('retry-after');
  const waitMs = header === null ? parseResetMs(headers.get('x-ratelimit-reset-tokens') ?? '') : Number(header) * 1000;
  if (/per day|\((?:TPD|RPD)\)|daily|quota/i.test(body)) return 'a daily or quota limit (429)';
  if (!/per minute|\((?:TPM|RPM)\)/i.test(body)) return 'a 429 that names no per-minute limit';
  return waitMs <= 300000 ? null : `a 429 asks to wait ${waitMs / 1000} s`;
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

const DEFAULT_CONTEXT = {
  contacts: [
    { id: 'c-alice', name: 'Alice', address: 'mtst1ap2t7nsjausqsgr57c58s2nqqg9f8m62' },
    { id: 'c-alice-work', name: 'Alice Work', address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e' },
    { id: 'c-bob', name: 'Bob', address: 'mtst1qp2t7nsjausqsgr57c58s2nqqg9f9999' }
  ],
  heldNicheTickers: [{ symbol: 'ZORK', tokenId: 'faucet-zork' }]
};

export async function runEval({
  offlineOnly = true,
  questions = false,
  commandsViaWorker = false,
  runs = commandsViaWorker ? 3 : 1,
  model = process.env.COMMAND_AI_MODEL || 'openai/gpt-oss-120b'
} = {}) {
  const schemaMod = loadTsModule('src/lib/command-ai/schema.ts');
  const redactorMod = loadTsModule('src/lib/command-ai/redactor.ts', {
    './schema': schemaMod
  });
  const cases = JSON.parse(readFileSync(path.join(__dirname, questions ? 'questions.json' : 'cases.json'), 'utf8'));
  let redactionFailures = 0;
  let provenanceFailures = 0;
  let obligationFailures = 0;
  let modelFailures = 0;
  const errors = [];
  const latencies = [];
  let maxPromptTokens = 0;
  let providerFailureDetail;
  let rateLimitHeaders = null;
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  let pacedMs = 0;
  const results = [];
  const retryBudget = freshRetryBudget();
  const viaWorker = questions || commandsViaWorker;
  const proxyMod =
    offlineOnly || viaWorker ? null : await import(path.join(ROOT, 'services/command-ai-proxy/server.mjs'));
  const worker =
    offlineOnly || !viaWorker
      ? null
      : loadTsModule('services/command-ai/src/index.ts', {
          './help-safety.mjs': { hasUnsafeSharingAdvice }
        }).createService({
          fetchImpl: async (...args) => {
            providerFailureDetail = undefined;
            const response = await fetch(...args);
            const body = await response.text();
            const stop = response.status === 429 ? hardLimitReason(response.headers, body) : null;
            if (stop) {
              console.error(`Quota stop: ${stop}. No further provider calls.`);
              process.exit(3);
            }
            if (response.status === 429) console.error('Waiting out a per-minute 429.');
            let data = null;
            try {
              data = JSON.parse(body);
            } catch {}
            const promptTokens = data?.usage?.prompt_tokens ?? 0;
            usage.calls += 1;
            usage.promptTokens += promptTokens;
            usage.completionTokens += data?.usage?.completion_tokens ?? 0;
            maxPromptTokens = Math.max(maxPromptTokens, promptTokens);
            const limits = [...response.headers].filter(([name]) => name.startsWith('x-ratelimit-'));
            if (limits.length > 0) rateLimitHeaders = Object.fromEntries(limits);
            const finishReason = data?.choices?.[0]?.finish_reason;
            providerFailureDetail = !response.ok
              ? `provider HTTP ${response.status}`
              : ['stop', 'length', 'content_filter', 'tool_calls'].includes(finishReason)
                ? `provider finish ${finishReason}`
                : undefined;
            const delayMs = paceDelayMs(response.headers, promptTokens);
            if (delayMs > 0) {
              pacedMs += delayMs;
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            // Rebuilt because the sleep can outlast the Worker's abort timer, which would break the original body.
            return new Response(response.status === 204 ? null : body, {
              status: response.status,
              headers: response.headers
            });
          }
        });

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

    const topic = testCase.expected?.topic;
    if ((topic === 'Pending' || topic === 'Recovery' || topic === 'Safety') && !testCase.answerContains?.length) {
      obligationFailures += 1;
      errors.push(`[OBLIGATION FAIL] ${testCase.id}: ${topic} requires answer substance`);
      continue;
    }

    if (worker || proxyMod) {
      const result = { id: testCase.id, passes: 0, runs, ops: [] };
      results.push(result);
      for (let attempt = 0; attempt < runs; attempt++) {
        providerFailureDetail = undefined;
        const t0 = Date.now();
        const pacedBefore = pacedMs;
        try {
          const res = await retryCompile(() =>
            worker
              ? worker
                  .fetch(
                    new Request('https://command-ai.test/v1/compile', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        redactedText: redaction.redactedText,
                        // The app sends a help context with every first message and none with a snapshot.
                        ...(testCase.snapshot
                          ? { snapshot: testCase.snapshot }
                          : { helpContext: commandsViaWorker ? (testCase.helpContext ?? null) : testCase.helpContext })
                      })
                    }),
                    {
                      ALLOWED_ORIGINS: '[]',
                      GROQ_API_KEY: process.env.GROQ_API_KEY,
                      COMMAND_AI_MODEL: model,
                      COMMAND_AI_RATE_LIMIT: { limit: async () => ({ success: true }) }
                    }
                  )
                  .then(async response => {
                    if (response.ok) return response.json();
                    const detail =
                      response.status === 502 && providerFailureDetail ? ` (${providerFailureDetail})` : '';
                    const error = new Error(`Worker returned ${response.status}${detail}`);
                    if (response.status === 429) {
                      const header = response.headers.get('Retry-After');
                      if (typeof header === 'string' && /^\d+$/.test(header)) {
                        const seconds = Number(header);
                        if (Number.isSafeInteger(seconds)) error.retryAfterSeconds = seconds;
                      }
                    }
                    throw error;
                  })
              : proxyMod.compileWithGroq({
                  redactedText: redaction.redactedText,
                  snapshot: testCase.snapshot,
                  apiKey: process.env.GROQ_API_KEY,
                  model
                })
          );
          latencies.push(Date.now() - t0 - (pacedMs - pacedBefore));
          maxPromptTokens = Math.max(maxPromptTokens, res.usage?.prompt_tokens ?? 0);
          const parsed = schemaMod.parseAiCompilerOutput(res.output);
          result.ops.push(parsed?.op ?? 'invalid');
          if (!parsed || !redactorMod.verifyProvenance(parsed, redaction.map)) {
            modelFailures += 1;
            errors.push(`[MODEL SCHEMA/PROV FAIL] ${testCase.id}: ${JSON.stringify(res.output)}`);
            continue;
          }
          const exp = testCase.expected;
          const matchesOp = [exp.op].flat().includes(parsed.op);
          const matchesAction = !exp.action || parsed.action === exp.action;
          const matchesAsset =
            !exp.asset || (parsed.asset ?? '').toUpperCase().replace(/[<>]/g, '') === exp.asset.toUpperCase();
          const matchesToAsset =
            !exp.to_asset || (parsed.to_asset ?? '').toUpperCase().replace(/[<>]/g, '') === exp.to_asset.toUpperCase();
          const matchesQuery = !exp.query || parsed.query === exp.query;
          const matchesTopic = !exp.topic || parsed.topic === exp.topic;
          const answer = parsed.answer?.toLowerCase().replaceAll('’', "'") ?? '';
          const answerCoversFacts =
            testCase.answerContains?.every(requirement => {
              const alternatives = Array.isArray(requirement) ? requirement : [requirement];
              return alternatives.some(term => answer.includes(term));
            }) ?? true;
          const matchesEarnOp = !exp.earn_op || parsed.earn_op === exp.earn_op;
          const matchesAmountKind =
            exp.amountKind === undefined ||
            (exp.amountKind === null ? parsed.amount === null : parsed.amount?.kind === exp.amountKind);

          if (
            !matchesOp ||
            !matchesAction ||
            !matchesAsset ||
            !matchesToAsset ||
            !matchesQuery ||
            !matchesTopic ||
            !answerCoversFacts ||
            !matchesEarnOp ||
            !matchesAmountKind
          ) {
            modelFailures += 1;
            errors.push(
              `[MODEL ACCURACY FAIL] ${testCase.id}: got ${JSON.stringify(parsed)}, expected subset ${JSON.stringify(exp)}`
            );
          } else {
            result.passes += 1;
          }
        } catch (err) {
          if (result.ops.length === attempt) result.ops.push('error');
          modelFailures += 1;
          errors.push(`[MODEL ERR] ${testCase.id}: ${err?.message || err}`);
        }
      }
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
    maxPromptTokens: maxPromptTokens || null,
    rateLimitHeaders,
    usage,
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
  const summary = await runEval({
    offlineOnly,
    questions: process.argv.includes('--questions'),
    commandsViaWorker: process.argv.includes('--commands')
  });
  const summaryPath = process.env.COMMAND_AI_EVAL_SUMMARY;
  // stdout also carries the Worker's log lines, so the artifact is written separately.
  if (summaryPath) writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  for (const err of summary.errors) console.error(err);
  console.log(JSON.stringify({ ...summary, errors: undefined, results: undefined }, null, 2));
  if (
    summary.redactionFailures > 0 ||
    summary.provenanceFailures > 0 ||
    summary.obligationFailures > 0 ||
    summary.modelFailures > 0
  ) {
    process.exit(1);
  }
}
