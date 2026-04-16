import * as fs from 'fs';
import * as path from 'path';

import type { TestStepRunner } from './test-step';
import type { TimelineRecorder } from './timeline-recorder';
import type { CLIInvocation, FailureCategory, TestFailureReport, WalletSnapshot } from './types';

import { computeDiagnosticHints } from './diagnostic-hints';

/**
 * Build a comprehensive failure report from all captured data.
 * This is the primary diagnostic document an AI agent reads on failure.
 */
export function buildFailureReport(opts: {
  testName: string;
  testFile: string;
  error: Error;
  timeline: TimelineRecorder;
  steps: TestStepRunner;
  stateAtFailure?: {
    walletA?: WalletSnapshot;
    walletB?: WalletSnapshot;
  };
  testTimeoutMs?: number;
}): TestFailureReport {
  const { testName, testFile, error, timeline, steps, stateAtFailure } = opts;
  const checkpoints = steps.getCheckpoints();
  const allEvents = timeline.getAllEvents();

  // Determine which step failed
  const failedCheckpoint = checkpoints.find(c => c.status === 'failed');
  const lastCheckpoint = checkpoints[checkpoints.length - 1];

  // Was it a timeout?
  const totalDurationMs = timeline.getElapsedMs();
  const wasTimeout =
    error.message.includes('timeout') ||
    error.message.includes('Timeout') ||
    (opts.testTimeoutMs ? totalDurationMs >= opts.testTimeoutMs * 0.95 : false);

  // Determine failure category
  let failureCategory: FailureCategory = failedCheckpoint?.error?.category ?? 'unknown';
  if (wasTimeout && failureCategory === 'unknown') {
    failureCategory = 'timeout_waiting_for_sync';
  }

  // Build step summary
  const stepSummary = checkpoints.map(c => ({
    index: c.index,
    name: c.name,
    status: c.status,
    durationMs: c.durationMs,
    assertionsPassed: c.assertions.filter(a => a.passed).length,
    assertionsFailed: c.assertions.filter(a => !a.passed).length,
  }));

  // Find slowest steps
  const slowestSteps = [...checkpoints]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(c => ({ name: c.name, durationMs: c.durationMs }));

  // Collect browser errors
  const browserErrors = allEvents
    .filter(e => e.category === 'browser_console' && e.severity === 'error')
    .map(e => ({
      wallet: e.wallet as 'A' | 'B',
      message: (e.data?.message as string) ?? e.message,
      stack: e.data?.stack as string | undefined,
      timestamp: e.timestamp,
    }));

  // Collect failed network requests
  const failedNetworkRequests = allEvents
    .filter(e => e.category === 'network_request' && e.severity === 'error')
    .map(e => ({
      wallet: e.wallet as 'A' | 'B',
      url: (e.data?.url as string) ?? '',
      status: (e.data?.status as number) ?? 0,
      failureText: e.data?.failureText as string | undefined,
      timestamp: e.timestamp,
    }));

  // Collect recent CLI commands
  const recentCliCommands = allEvents
    .filter(e => e.category === 'cli_command')
    .slice(-10)
    .map(e => e.data as unknown as CLIInvocation);

  // Determine last action
  const lastActionEvent = allEvents
    .filter(e => e.category !== 'test_lifecycle')
    .slice(-1)[0];

  const report: TestFailureReport = {
    testName,
    testFile,
    status: wasTimeout ? 'timedout' : 'failed',
    failureCategory,

    error: {
      message: error.message,
      stack: error.stack ?? '',
      expected: (error as any).expected,
      actual: (error as any).actual,
    },

    failedAtStep: {
      index: failedCheckpoint?.index ?? lastCheckpoint?.index ?? 0,
      name: failedCheckpoint?.name ?? lastCheckpoint?.name ?? 'unknown',
      durationMs: failedCheckpoint?.durationMs ?? lastCheckpoint?.durationMs ?? 0,
      lastAction: lastActionEvent?.message ?? 'unknown',
    },

    stepSummary,

    timing: {
      totalDurationMs,
      wasTimeout,
      slowestSteps,
    },

    recentEvents: timeline.getRecentEvents(50),
    stateAtFailure: stateAtFailure ?? {},
    recentCliCommands,
    browserErrors,
    failedNetworkRequests,

    artifacts: {
      fullTimeline: 'timeline.ndjson',
      checkpoints: 'checkpoints.json',
      traces: [],
    },

    diagnosticHints: [], // filled below
  };

  report.diagnosticHints = computeDiagnosticHints(report);

  return report;
}

/**
 * Save the failure report to disk.
 */
export function saveFailureReport(report: TestFailureReport, outputDir: string): string {
  const filePath = path.join(outputDir, 'report.json');
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}
