import type { Page } from '@playwright/test';

// ── Event Categories ──────────────────────────────────────────────────────────

export type EventCategory =
  | 'test_lifecycle'
  | 'ui_action'
  | 'ui_assertion'
  | 'cli_command'
  | 'blockchain_state'
  | 'browser_console'
  | 'network_request'
  | 'state_snapshot'
  | 'error';

export type EventSeverity = 'info' | 'warn' | 'error' | 'debug';

// ── Timeline Event ────────────────────────────────────────────────────────────

export interface TimelineEvent {
  timestamp: string;
  elapsedMs: number;
  stepIndex: number;
  stepName: string;
  category: EventCategory;
  severity: EventSeverity;
  wallet?: 'A' | 'B';
  message: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

// ── Failure Categories ────────────────────────────────────────────────────────

export type FailureCategory =
  | 'ui_element_not_found'
  | 'ui_element_wrong_state'
  | 'assertion_value_mismatch'
  | 'timeout_waiting_for_sync'
  | 'timeout_waiting_for_transaction'
  | 'cli_command_failed'
  | 'network_error'
  | 'browser_console_error'
  | 'extension_crash'
  | 'unknown';

// ── Run Manifest ──────────────────────────────────────────────────────────────

export interface RunManifest {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  environment: {
    nodeVersion: string;
    playwrightVersion: string;
    chromeVersion: string;
    os: string;
    network: string;
    rpcEndpoint: string;
    midenClientBin: string;
  };
  tests: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped' | 'timedout';
    durationMs: number;
    failureCategory?: FailureCategory;
    reportPath: string;
  }>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    timedout: number;
    skipped: number;
  };
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

export interface AssertionResult {
  description: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  waitedMs?: number;
}

export interface Checkpoint {
  index: number;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  assertions: AssertionResult[];
  screenshotPaths?: { walletA?: string; walletB?: string };
  stateSnapshotPaths?: { walletA?: string; walletB?: string };
  error?: {
    message: string;
    stack: string;
    category: FailureCategory;
  };
}

// ── Step Options ──────────────────────────────────────────────────────────────

export interface StepOptions {
  screenshotWallets?: Array<{ page: Page; label: 'A' | 'B' }>;
  captureStateFrom?: Array<{ page: Page; label: 'A' | 'B'; extensionId: string }>;
}

// ── CLI Invocation ────────────────────────────────────────────────────────────

export interface CLIInvocation {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  timeoutMs?: number;
  parsed?: {
    faucetId?: string;
    accountId?: string;
    noteId?: string;
    transactionId?: string;
  };
}

// ── Wallet Snapshot ───────────────────────────────────────────────────────────

export interface WalletSnapshot {
  capturedAt: string;
  wallet: 'A' | 'B';
  stepIndex: number;
  stepName: string;
  extensionId: string;
  walletState?: {
    status: string;
    accountCount: number;
    currentAccountPublicKey: string | null;
    currentAccountName: string | null;
  };
  balances?: Array<{
    faucetId: string;
    symbol: string;
    amount: string;
  }>;
  claimableNotes?: Array<{
    noteId: string;
    amount: string;
    noteType: string;
  }>;
  pendingTransactions?: Array<{
    id: string;
    status: string;
  }>;
  currentUrl: string;
  serviceWorkerStatus: 'active' | 'inactive' | 'not_found';
}

// ── Network Record ────────────────────────────────────────────────────────────

export type NetworkCategory = 'rpc' | 'transport' | 'prover' | 'other';

export interface NetworkRecord {
  timestamp: string;
  wallet: 'A' | 'B';
  url: string;
  method: string;
  status: number;
  responseBody?: string;
  durationMs: number;
  failed: boolean;
  failureText?: string;
  category: NetworkCategory;
}

// ── Failure Report ────────────────────────────────────────────────────────────

export interface TestFailureReport {
  testName: string;
  testFile: string;
  status: 'failed' | 'timedout';
  failureCategory: FailureCategory;

  error: {
    message: string;
    stack: string;
    expected?: string;
    actual?: string;
  };

  failedAtStep: {
    index: number;
    name: string;
    durationMs: number;
    lastAction: string;
  };

  stepSummary: Array<{
    index: number;
    name: string;
    status: string;
    durationMs: number;
    assertionsPassed: number;
    assertionsFailed: number;
  }>;

  timing: {
    totalDurationMs: number;
    wasTimeout: boolean;
    slowestSteps: Array<{ name: string; durationMs: number }>;
  };

  recentEvents: TimelineEvent[];
  stateAtFailure: {
    walletA?: WalletSnapshot;
    walletB?: WalletSnapshot;
  };
  recentCliCommands: CLIInvocation[];
  browserErrors: Array<{
    wallet: 'A' | 'B';
    message: string;
    stack?: string;
    timestamp: string;
  }>;
  failedNetworkRequests: Array<{
    wallet: 'A' | 'B';
    url: string;
    status: number;
    failureText?: string;
    timestamp: string;
  }>;
  artifacts: {
    failureScreenshots?: string[];
    traces: string[];
    fullTimeline: string;
    checkpoints: string;
  };
  diagnosticHints: string[];
}

// ── Debug Session (Agentic Mode) ─────────────────────────────────────────────

export interface DebugSession {
  createdAt: string;
  testName: string;
  reportPath: string;
  wallets: {
    A: {
      extensionId: string;
      fullpageUrl: string;
      cdpUrl: string;
      userDataDir: string;
    };
    B: {
      extensionId: string;
      fullpageUrl: string;
      cdpUrl: string;
      userDataDir: string;
    };
  };
  midenCliWorkDir: string;
  expiresAt: string;
  helpers: {
    reloadAndReopen: string;
    rebuildCmd: string;
  };
}

// ── Environment Config ────────────────────────────────────────────────────────

export interface EnvironmentConfig {
  name: string;
  rpcUrl: string;
  provingUrl?: string;
  transportUrl?: string;
  networkFlag: string;
  pollIntervalMs: number;
  txTimeoutMs: number;
  mintAmount: number;
  delegateProving: boolean;
}
