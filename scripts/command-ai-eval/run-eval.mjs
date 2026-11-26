import { readFileSync } from 'node:fs';
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
  model = process.env.COMMAND_AI_MODEL || 'openai/gpt-oss-120b'
} = {}) {
  const schemaMod = loadTsModule('src/lib/command-ai/schema.ts');
  const redactorMod = loadTsModule('src/lib/command-ai/redactor.ts', {
    './schema': schemaMod
  });
  const proxyMod = offlineOnly ? null : await import(path.join(ROOT, 'services/command-ai-proxy/server.mjs'));

  const cases = JSON.parse(readFileSync(path.join(__dirname, questions ? 'questions.json' : 'cases.json'), 'utf8'));
  let redactionFailures = 0;
  let provenanceFailures = 0;
  let modelFailures = 0;
  const errors = [];
  const latencies = [];
  let maxPromptTokens = 0;

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

    if (!offlineOnly && proxyMod) {
      const t0 = Date.now();
      try {
        const res = await proxyMod.compileWithGroq({
          redactedText: redaction.redactedText,
          snapshot: testCase.snapshot,
          helpContext: testCase.helpContext,
          apiKey: process.env.GROQ_API_KEY,
          model
        });
        latencies.push(Date.now() - t0);
        maxPromptTokens = Math.max(maxPromptTokens, res.usage?.prompt_tokens ?? 0);
        const parsed = schemaMod.parseAiCompilerOutput(res.output);
        if (!parsed || !redactorMod.verifyProvenance(parsed, redaction.map)) {
          modelFailures += 1;
          errors.push(`[MODEL SCHEMA/PROV FAIL] ${testCase.id}: ${JSON.stringify(res.output)}`);
          continue;
        }
        const exp = testCase.expected;
        const matchesOp = parsed.op === exp.op;
        const matchesAction = !exp.action || parsed.action === exp.action;
        const matchesAsset =
          !exp.asset || (parsed.asset ?? '').toUpperCase().replace(/[<>]/g, '') === exp.asset.toUpperCase();
        const matchesToAsset =
          !exp.to_asset || (parsed.to_asset ?? '').toUpperCase().replace(/[<>]/g, '') === exp.to_asset.toUpperCase();
        const matchesQuery = !exp.query || parsed.query === exp.query;
        const matchesTopic = !exp.topic || parsed.topic === exp.topic;
        const answerCoversFacts =
          !testCase.answerContains ||
          testCase.answerContains.every(term => parsed.answer?.toLowerCase().includes(term));
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
        }
      } catch (err) {
        modelFailures += 1;
        errors.push(`[MODEL ERR] ${testCase.id}: ${err?.message || err}`);
      }
    }
  }

  return {
    mode: offlineOnly ? 'offline' : `live:${model}`,
    totalCases: cases.length,
    redactionFailures,
    provenanceFailures,
    modelFailures,
    maxPromptTokens: maxPromptTokens || null,
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
  const summary = await runEval({ offlineOnly, questions: process.argv.includes('--questions') });
  for (const err of summary.errors) console.error(err);
  console.log(JSON.stringify({ ...summary, errors: undefined }, null, 2));
  if (summary.redactionFailures > 0 || summary.provenanceFailures > 0 || summary.modelFailures > 0) {
    process.exit(1);
  }
}
