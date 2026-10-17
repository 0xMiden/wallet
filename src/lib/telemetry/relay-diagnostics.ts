/**
 * What a crash report adds when it is the WalletConnect relay connection failing, as fixed values only
 * (BREAD-WALLET-5).
 *
 * The browser never says why a relay handshake failed, so the report says what can tell the causes apart instead:
 * whether the network had just changed, whether the window was on screen, which window it was, whether its connect
 * modal was open, whether the relay ever connected there, and how often it had failed. Import-free, so the pages and
 * AppKit's setup can feed it without loading the crash client.
 */
export const RELAY_SERVICE = 'walletconnect_relay';
// A failure while offline is counted but never reported, so `offline` is not a value a report can carry.
export const RELAY_CONNECTIVITY = ['just_changed', 'steady'] as const;
export const RELAY_VISIBILITY = ['visible', 'hidden'] as const;
export const RELAY_SURFACES = ['popup', 'fullpage', 'sidepanel', 'confirm'] as const;
export const RELAY_TRIGGERS = ['connect_modal', 'no_connect_modal'] as const;
export const RELAY_FAILURE_BUCKETS = ['1', '2-5', '6+'] as const;

export type RelaySurface = (typeof RELAY_SURFACES)[number];

export type RelayDiagnostics = {
  service: typeof RELAY_SERVICE;
  connectivity: (typeof RELAY_CONNECTIVITY)[number];
  visibility?: (typeof RELAY_VISIBILITY)[number];
  surface?: RelaySurface;
  relayTrigger: (typeof RELAY_TRIGGERS)[number];
  relayEverConnected: boolean;
  relayFailures: (typeof RELAY_FAILURE_BUCKETS)[number];
};

/** A relay failure: withheld, or to be reported under its fixed text with its fixed values once its range is claimed. */
export type RelayFailure = { report: false } | { report: true; message: string; diagnostics: RelayDiagnostics };

/** The part of AppKit's relayer this module reads and listens to. */
export type RelayConnection = {
  readonly connected: boolean;
  on(event: string, listener: () => void): void;
};

// WalletConnect's own text for a failed relay socket, followed by the relay's URL.
const FAILURE_PREFIX = 'WebSocket connection failed for host: ';
const RELAY_HOSTS = ['relay.walletconnect.org', 'relay.walletconnect.com'] as const;
// WalletConnect reconnects the moment `online` fires, which can be before the network resolves names again.
const CONNECTIVITY_SETTLE_MS = 30_000;

let surface: RelaySurface | undefined;
let connectModalOpen = false;
let everConnected = false;
let connectivityChangedAt: number | undefined;
let failures = 0;
// One failure can reach the reporter more than once (a global handler, the error boundary, a manual capture).
let counted = new WeakSet<Error>();
// The highest range a report was sent for, as its index in `RELAY_FAILURE_BUCKETS`.
let reportedRank = -1;

export function recordRelaySurface(next: RelaySurface): void {
  if (RELAY_SURFACES.includes(next)) surface = next;
}

export function noteConnectModalOpen(open: boolean): void {
  connectModalOpen = open;
}

export function noteConnectivityChanged(): void {
  connectivityChangedAt = Date.now();
}

/** Reads whether the relay is connected and listens for it connecting; changes nothing about the relay. */
export function followRelay(relayer: RelayConnection): void {
  const connected = () => {
    everConnected = true;
  };
  if (relayer.connected) connected();
  relayer.on('relayer_connect', connected);
}

function relayHost(message: string): (typeof RELAY_HOSTS)[number] | undefined {
  if (!message.startsWith(FAILURE_PREFIX)) return undefined;
  let hostname: string;
  try {
    hostname = new URL(message.slice(FAILURE_PREFIX.length)).hostname;
  } catch {
    return undefined;
  }
  return RELAY_HOSTS.find(host => host === hostname);
}

function failureBucket(count: number): RelayDiagnostics['relayFailures'] {
  if (count === 1) return '1';
  return count <= 5 ? '2-5' : '6+';
}

const rank = (bucket: RelayDiagnostics['relayFailures']): number => RELAY_FAILURE_BUCKETS.indexOf(bucket);

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * `undefined` unless `error` is WalletConnect's failed relay socket on one of WalletConnect's own relay hosts. Each
 * Error counts once, and its range is only named here: {@link claimRelayRange} uses it up when the report is sent.
 */
export function classifyRelayFailure(error: Error): RelayFailure | undefined {
  const message: unknown = error.message;
  if (typeof message !== 'string') return undefined;
  const host = relayHost(message);
  if (host === undefined) return undefined;
  if (counted.has(error)) return { report: false };
  counted.add(error);
  failures++;
  const bucket = failureBucket(failures);
  // A blip sends one report and a stuck window three; a failure while offline uses none of them up.
  if (isOffline() || rank(bucket) <= reportedRank) return { report: false };
  const visibility =
    typeof document === 'undefined' ? undefined : RELAY_VISIBILITY.find(state => state === document.visibilityState);
  const justChanged =
    connectivityChangedAt !== undefined && Date.now() - connectivityChangedAt <= CONNECTIVITY_SETTLE_MS;
  return {
    report: true,
    message: `${FAILURE_PREFIX}wss://${host}`,
    diagnostics: {
      service: RELAY_SERVICE,
      connectivity: justChanged ? 'just_changed' : 'steady',
      ...(visibility === undefined ? {} : { visibility }),
      ...(surface === undefined ? {} : { surface }),
      relayTrigger: connectModalOpen ? 'connect_modal' : 'no_connect_modal',
      relayEverConnected: everConnected,
      relayFailures: bucket
    }
  };
}

/**
 * Uses up `bucket`'s range, immediately before its report is captured. `false`, using nothing up, while the device is
 * offline (it can go offline after the failure was classified) or when that range or a higher one was already sent,
 * so of two failures of one range only the first to get here is reported, and never after a later range.
 */
export function claimRelayRange(bucket: RelayDiagnostics['relayFailures']): boolean {
  if (isOffline() || rank(bucket) <= reportedRank) return false;
  reportedRank = rank(bucket);
  return true;
}

/** Test-only: forget this window's relay history, as a fresh page load would. */
export function __resetRelayDiagnosticsForTest(): void {
  surface = undefined;
  connectModalOpen = false;
  everConnected = false;
  connectivityChangedAt = undefined;
  failures = 0;
  counted = new WeakSet();
  reportedRank = -1;
}
