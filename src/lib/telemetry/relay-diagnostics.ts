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

/** A relay failure: withheld, or reported under its fixed text with its fixed values. */
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
const reportedBuckets = new Set<RelayDiagnostics['relayFailures']>();

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

/** `undefined` unless `message` is WalletConnect's failed relay socket on one of WalletConnect's own relay hosts. */
export function classifyRelayFailure(message: unknown): RelayFailure | undefined {
  if (typeof message !== 'string') return undefined;
  const host = relayHost(message);
  if (host === undefined) return undefined;
  failures++;
  const bucket = failureBucket(failures);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  // Each bucket is reported once, by its first failure while online: a blip sends one report, a stuck window three,
  // and a failure while offline uses none of them up.
  if (offline || reportedBuckets.has(bucket)) return { report: false };
  reportedBuckets.add(bucket);
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

/** Test-only: forget this window's relay history, as a fresh page load would. */
export function __resetRelayDiagnosticsForTest(): void {
  surface = undefined;
  connectModalOpen = false;
  everConnected = false;
  connectivityChangedAt = undefined;
  failures = 0;
  reportedBuckets.clear();
}
