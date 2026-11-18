'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { mkdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const schema = require('./report.schema.json');

const MAX_REPORT_BYTES = 512 * 1024;
const REPORT_FILENAME = 'wallet-e2e-report-v1.json';
const KNOWN_STAGE_ERRORS = new Map(
  schema.$defs.error.anyOf
    .filter(branch => branch.properties)
    .map(branch => [branch.properties.code.const, branch.properties.explanation.const])
);

function known(value) {
  return { value, reason: null };
}

function unknown(reason = 'not_observed') {
  return { value: null, reason };
}

function valueOrUnknown(value, reason) {
  return value == null ? unknown(reason) : known(value);
}

function matches(value, rule) {
  if (rule.$ref) return matches(value, schema.$defs[rule.$ref.slice('#/$defs/'.length)]);
  if (rule.anyOf) return rule.anyOf.some(branch => matches(value, branch));
  if (Object.hasOwn(rule, 'const')) return value === rule.const;
  if (rule.enum) return rule.enum.includes(value);

  switch (rule.type) {
    case 'object':
      return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === rule.required.length &&
        rule.required.every(key => Object.hasOwn(value, key) && matches(value[key], rule.properties[key]))
      );
    case 'array':
      return Array.isArray(value) && value.length <= rule.maxItems && value.every(item => matches(item, rule.items));
    case 'string':
      return typeof value === 'string' && value.length <= rule.maxLength && new RegExp(rule.pattern, 'u').test(value);
    case 'integer':
      return Number.isSafeInteger(value) && value >= rule.minimum && value <= rule.maximum;
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function validTimes(record) {
  for (const name of ['startAt', 'endAt', 'deadlineAt']) {
    const value = record[name]?.value;
    if (value == null) continue;
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value.replace(/(?<!\.\d{3})Z$/, '.000Z')) {
      return false;
    }
  }
  return (
    !record.startAt?.value || !record.endAt?.value || Date.parse(record.startAt.value) <= Date.parse(record.endAt.value)
  );
}

function errorFor(code) {
  const explanation = KNOWN_STAGE_ERRORS.get(code);
  return explanation ? { code, explanation } : null;
}

function createStage(input) {
  const stage = {
    key: input.key,
    status: input.status,
    origin: input.origin,
    evidence: input.evidence ?? 'observed',
    reason: input.reason ?? null,
    startAt: valueOrUnknown(input.startAt),
    endAt: valueOrUnknown(input.endAt),
    elapsedMs: valueOrUnknown(input.elapsedMs),
    timeoutMs: valueOrUnknown(input.timeoutMs, 'not_applicable'),
    deadlineAt: valueOrUnknown(input.deadlineAt, 'not_applicable'),
    httpStatus: valueOrUnknown(
      input.httpStatus,
      input.endpoint?.startsWith('inicio_') ? 'not_observed' : 'not_applicable'
    ),
    priceAgeMs: valueOrUnknown(
      input.priceAgeMs,
      input.endpoint === 'inicio_pair_price' ? 'not_observed' : 'not_applicable'
    ),
    endpoint: input.endpoint ?? null,
    error: errorFor(input.errorCode)
  };
  if (!matches(stage, schema.$defs.stage) || !validTimes(stage)) {
    throw new Error('Invalid wallet E2E observation');
  }
  return stage;
}

function createOperation(input) {
  const operation = {
    key: input.key,
    kind: input.kind,
    surface: input.surface ?? 'unknown',
    sourceRunId: valueOrUnknown(input.sourceRunId, input.kind === 'recovery' ? 'not_observed' : 'not_applicable'),
    recoveryEffect: input.recoveryEffect ?? (input.kind === 'recovery' ? 'unknown' : 'not_applicable'),
    outcome: input.outcome ?? 'unknown',
    provider: input.provider ?? null,
    sourceNetwork: input.sourceNetwork ?? null,
    destinationNetwork: input.destinationNetwork ?? null,
    offered: valueOrUnknown(input.offered),
    minimum: valueOrUnknown(input.minimum),
    received: valueOrUnknown(input.received),
    fee: valueOrUnknown(input.fee),
    stages: []
  };
  if (!matches(operation, schema.$defs.operation)) throw new Error('Invalid wallet E2E operation');
  return operation;
}

function requireReport(report) {
  if (!matches(report, schema)) throw new Error('Invalid wallet E2E report');
  if (!validTimes({ startAt: known(report.generatedAt) }) || !validTimes(report) || !report.stages.every(validTimes)) {
    throw new Error('Invalid wallet E2E observation time');
  }
  const unique = values => values.length === new Set(values).size;
  if (!unique(report.invocations.map(row => row.id))) throw new Error('Duplicate wallet E2E invocation');
  for (const invocation of report.invocations) {
    if (!validTimes(invocation) || !unique(invocation.tests.map(test => test.id))) {
      throw new Error('Invalid wallet E2E invocation');
    }
    for (const test of invocation.tests) {
      if (!unique(test.attempts.map(attempt => attempt.retry))) throw new Error('Duplicate wallet E2E test retry');
      for (const attempt of test.attempts) {
        if (
          !validTimes(attempt) ||
          !unique(attempt.operations.map(operation => operation.key)) ||
          !attempt.operations.every(operation => operation.stages.every(validTimes))
        ) {
          throw new Error('Invalid wallet E2E attempt');
        }
      }
    }
  }
  return report;
}

function formatReport(report) {
  const content = JSON.stringify(requireReport(report), null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_REPORT_BYTES) throw new Error('Wallet E2E report exceeds byte limit');
  return content;
}

function publishAtomically(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function makeReport(input) {
  return {
    schemaVersion: 'wallet-e2e/v1',
    producerVersion: '1.0.0',
    generatedAt: input.generatedAt,
    units: 'milliseconds',
    clockPolicy: 'utc_observation_and_monotonic_elapsed',
    synthetic: true,
    fixture: input.fixture === true,
    network: 'mainnet',
    testEnvironment: 'chrome_extension',
    availability: input.availability,
    repository: input.repository,
    workflowId: input.workflowId,
    workflowPath: input.workflowPath,
    sourceSha: input.sourceSha,
    sourceRef: input.sourceRef,
    event: input.event,
    runId: input.runId,
    runNumber: input.runNumber,
    runAttempt: input.runAttempt,
    jobKey: input.jobKey,
    jobId: valueOrUnknown(input.jobId, 'github_metadata_only'),
    startAt: valueOrUnknown(input.startAt),
    endAt: valueOrUnknown(input.endAt),
    elapsedMs: valueOrUnknown(input.elapsedMs),
    timeoutMs: valueOrUnknown(input.timeoutMs),
    build: input.build ?? {
      extensionVersion: unknown(),
      extensionSha256: unknown(),
      sdkVersion: unknown(),
      remoteConfigSha256: unknown(),
      endpointLabels: []
    },
    coverage: input.coverage,
    stages: input.stages,
    invocations: input.invocations
  };
}

function testId(spec, title) {
  return createHash('sha256')
    .update(spec + '\0' + title)
    .digest('hex')
    .slice(0, 24);
}

module.exports = {
  MAX_REPORT_BYTES,
  REPORT_FILENAME,
  createOperation,
  createStage,
  errorFor,
  formatReport,
  known,
  makeReport,
  matches,
  publishAtomically,
  requireReport,
  schema,
  testId,
  unknown,
  valueOrUnknown
};
