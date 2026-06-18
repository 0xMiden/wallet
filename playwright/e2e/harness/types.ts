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
  | 'stress_op'
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
  | 'app_crash'
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
    runtimeInfo: { kind: 'chrome' | 'ios'; version: string };
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

// ── Capability Surfaces (platform-neutral) ───────────────────────────────────

/**
 * Minimal capability for taking screenshots. Playwright's Page satisfies this
 * natively; IosWalletPage exposes the same shape by delegating to
 * `xcrun simctl io <udid> screenshot`.
 */
export interface ScreenshotCapable {
  screenshot(opts: { path: string }): Promise<Buffer | void>;
}

/**
 * Minimal capability for evaluating JavaScript in the wallet runtime.
 * Function-based to match Playwright's Page.evaluate semantically — passing a
 * raw string would mean function-body on Chrome but expression on iOS CDP, and
 * the silent drift would bite. iOS implementations stringify the function via
 * Function.prototype.toString and wrap as an IIFE; closures must not reference
 * captured variables (callers in this harness comply — they only read
 * `window.__TEST_*` globals).
 */
export interface StateCaptureCapable {
  evaluate<T = unknown>(fn: () => T | Promise<T>): Promise<T>;
}

// ── Snapshot Capabilities ─────────────────────────────────────────────────────

/**
 * The shape returned by SnapshotCaps.readStore — the parts of the Zustand
 * store that the snapshot consumer needs. Defined here (not in state-snapshot)
 * because the fixture supplies the closure that produces it.
 */
export interface SerializedWalletState {
  status: number | string;
  accounts?: Array<{ publicKey: string; name?: string }>;
  currentAccount?: { publicKey: string; name?: string } | null;
  balances?: Record<string, unknown>;
}

export type ServiceWorkerStatus = 'active' | 'inactive' | 'not_found';

/**
 * Per-wallet capabilities the fixture pre-binds at setup time and passes to
 * the test step runner. State capture stays platform-neutral — the fixture
 * decides how to read the store and (where applicable) the service worker
 * status, then test-step just calls the closures.
 */
export interface SnapshotCaps {
  platform: 'chrome' | 'ios';
  runtimeVersion: string;
  extensionId?: string;
  readStore: () => Promise<SerializedWalletState | null>;
  hasIntercom: () => Promise<boolean>;
  /** Chrome only — iOS has no service worker concept. Omit on iOS. */
  serviceWorkerStatus?: () => Promise<ServiceWorkerStatus>;
  /** The current page/webview URL at capture time. */
  currentUrl: () => Promise<string>;
}

// ── Step Options ──────────────────────────────────────────────────────────────

export interface StepOptions {
  screenshotWallets?: Array<{ target: ScreenshotCapable; label: 'A' | 'B' }>;
  captureStateFrom?: Array<{ target: StateCaptureCapable; label: 'A' | 'B'; extensionId?: string }>;
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
  /** Discriminator: which runtime captured this snapshot. */
  platform: 'chrome' | 'ios';
  /** Runtime version (Chrome version on chrome, iOS version on ios). */
  runtimeVersion?: string;
  /** Chrome-only — extension id. Omitted on ios. */
  extensionId?: string;
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
  /** Chrome-only — service worker status. Omitted on ios. */
  serviceWorkerStatus?: ServiceWorkerStatus;
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
