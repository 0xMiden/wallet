import {
  ANSWER_WAIT_MS,
  AppConnection,
  AppSession,
  ConnectAnswer,
  DAppMessage,
  finishConnect,
  isRecord,
  ProtocolError,
  readLink,
  readResponse,
  RequestAnswer,
  sendRequest,
  startConnect,
  TransactionOutcome
} from '@miden-sdk/bread-connect';

import { KeyValueStorage, readJson, writeJson } from './storage.js';

const SESSION_KEY = 'bread-connect:session';
const PENDING_KEY = 'bread-connect:pending';
const OUTCOMES_KEY = 'bread-connect:outcomes';
const OUTCOME_LIMIT = 20;

/** The links the app is opened with. */
export interface LinkSource {
  launchUrl(): Promise<string | undefined>;
  onUrl(listener: (url: string) => void): () => void;
}

export interface TransportOptions {
  /** The app's https callback; its association files give the link to the app. */
  callback: string;
  storage: KeyValueStorage;
  links: LinkSource;
  /** Opens Bread's link in Bread only; false when Bread is not installed and its store page opened instead. */
  openWallet: (link: string) => Promise<boolean>;
  now?: () => number;
}

/** A connected session, with the permission request it answered and Bread's answer. */
export interface StoredSession extends AppSession {
  request: DAppMessage;
  permission: DAppMessage;
}

type Pending =
  | { kind: 'connect'; connection: AppConnection; request: DAppMessage; sentAt: number }
  | { kind: 'request'; id: string; session: string; sentAt: number };

interface Waiter {
  pending: Pending;
  resolve: (answer: DAppMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type BreadConnectErrorCode = ProtocolError['code'] | 'NOT_INSTALLED' | 'SUPERSEDED' | 'CANCELLED' | 'TIMEOUT';

export class BreadConnectError extends Error {
  name = 'BreadConnectError';

  constructor(
    readonly code: BreadConnectErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * Carries requests to Bread and its answers back through app switches, one request at a time: a new request
 * replaces the one still waiting. The session and the waiting request are stored, so an answer that relaunches
 * the app after the system stopped it still completes a connection and records a transaction's outcome.
 */
export class AppSwitchTransport {
  private waiter: Waiter | null = null;
  private started: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: TransportOptions) {}

  /** Listens for Bread's answers and reads the link the app was launched with. */
  start(): Promise<void> {
    if (!this.started) {
      this.unsubscribe = this.options.links.onUrl(url => this.receive(url));
      this.started = this.options.links
        .launchUrl()
        .then(url => {
          if (url) this.receive(url);
        })
        .catch(() => undefined);
    }
    return this.started;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = null;
    this.cancelPending();
  }

  session(): StoredSession | null {
    const stored = readJson(this.options.storage, SESSION_KEY);
    return isStoredSession(stored) ? stored : null;
  }

  forgetSession(): void {
    this.options.storage.removeItem(SESSION_KEY);
  }

  /** The outcome Bread reported with a transaction's answer, when this app sent it. */
  transactionOutcome(transactionId: string): TransactionOutcome | undefined {
    const outcomes = readJson(this.options.storage, OUTCOMES_KEY);
    if (!Array.isArray(outcomes)) return undefined;
    for (const entry of outcomes) {
      if (isRecord(entry) && entry.transactionId === transactionId && isOutcome(entry.outcome)) return entry.outcome;
    }
    return undefined;
  }

  /** Asks Bread for a permission; resolves with Bread's PERMISSION_RESPONSE and keeps the session. */
  async connect(request: DAppMessage): Promise<DAppMessage> {
    await this.start();
    const { link, connection } = startConnect(this.options.callback, request);
    return this.exchange({ kind: 'connect', connection, request, sentAt: this.now() }, link);
  }

  /** Sends a request in the connected session; resolves with Bread's response. */
  async request(request: DAppMessage): Promise<DAppMessage> {
    await this.start();
    const session = this.session();
    if (!session) throw new BreadConnectError('NOT_GRANTED', 'The app is not connected to Bread');
    const sentAt = this.now();
    const { link, id } = sendRequest(session, request, sentAt);
    return this.exchange({ kind: 'request', id, session: session.session, sentAt }, link);
  }

  /** Stops waiting for the answer to the request in flight. */
  cancelPending(): void {
    this.settle(new BreadConnectError('CANCELLED', 'The request to Bread was cancelled'));
  }

  /** Reads a link the app was opened with; anything but an answer to the waiting request is dropped. */
  receive(url: string): void {
    const read = readLink(url, this.options.callback);
    if (read?.kind !== 'envelope') return;
    const pending = this.waiter?.pending ?? this.storedPending();
    if (!pending) return;
    const envelope = read.envelope;

    if (envelope.type === 'connected' && pending.kind === 'connect' && envelope.id === pending.connection.id) {
      let finished: ReturnType<typeof finishConnect>;
      try {
        finished = finishConnect(envelope, pending.connection);
      } catch {
        return;
      }
      if ('response' in finished.answer) {
        const session: StoredSession = {
          ...finished.session,
          request: pending.request,
          permission: finished.answer.response
        };
        writeJson(this.options.storage, SESSION_KEY, session);
      }
      this.settle(finished.answer);
      return;
    }

    if (envelope.type === 'response' && pending.kind === 'request' && envelope.id === pending.id) {
      const session = this.session();
      if (!session || session.session !== pending.session) return;
      let answer: RequestAnswer;
      try {
        answer = readResponse(envelope, session);
      } catch {
        return;
      }
      const transactionId = 'response' in answer ? answer.response.transactionId : undefined;
      if ('response' in answer && answer.transaction && typeof transactionId === 'string') {
        this.recordOutcome(transactionId, answer.transaction);
      }
      this.settle(answer);
      return;
    }

    if (envelope.type === 'error' && envelope.id !== undefined && envelope.id === pendingId(pending)) {
      if (envelope.error.code === 'SESSION_NOT_FOUND') this.forgetSession();
      this.settle({ error: envelope.error });
    }
  }

  private exchange(pending: Pending, link: string): Promise<DAppMessage> {
    this.settle(new BreadConnectError('SUPERSEDED', 'A newer request to Bread replaced this one'));
    writeJson(this.options.storage, PENDING_KEY, pending);
    const answer = new Promise<DAppMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(new BreadConnectError('TIMEOUT', 'Bread did not answer in time')),
        ANSWER_WAIT_MS
      );
      this.waiter = { pending, resolve, reject, timer };
    });
    const waiter = this.waiter;
    this.options.openWallet(link).then(
      opened => {
        if (!opened && this.waiter === waiter) {
          this.settle(new BreadConnectError('NOT_INSTALLED', 'Bread is not installed; its store page is open'));
        }
      },
      error => {
        if (this.waiter === waiter) {
          this.settle(new BreadConnectError('INTERNAL_ERROR', `Bread could not be opened: ${String(error)}`));
        }
      }
    );
    return answer;
  }

  /** Ends the waiting request, if any, and forgets it. */
  private settle(outcome: ConnectAnswer | RequestAnswer | BreadConnectError): void {
    this.options.storage.removeItem(PENDING_KEY);
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    clearTimeout(waiter.timer);
    if (outcome instanceof BreadConnectError) waiter.reject(outcome);
    else if ('error' in outcome) waiter.reject(new BreadConnectError(outcome.error.code, outcome.error.message));
    else waiter.resolve(outcome.response);
  }

  private storedPending(): Pending | null {
    const stored = readJson(this.options.storage, PENDING_KEY);
    if (!isPending(stored) || this.now() - stored.sentAt > ANSWER_WAIT_MS) return null;
    return stored;
  }

  private recordOutcome(transactionId: string, outcome: TransactionOutcome): void {
    const stored = readJson(this.options.storage, OUTCOMES_KEY);
    const kept = Array.isArray(stored)
      ? stored.filter(entry => isRecord(entry) && entry.transactionId !== transactionId)
      : [];
    writeJson(this.options.storage, OUTCOMES_KEY, [...kept, { transactionId, outcome }].slice(-OUTCOME_LIMIT));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function pendingId(pending: Pending): string {
  return pending.kind === 'connect' ? pending.connection.id : pending.id;
}

function isDAppMessage(value: unknown): value is DAppMessage {
  return isRecord(value) && typeof value.type === 'string';
}

function isStrings<T extends Record<string, unknown>, K extends string>(
  value: T,
  keys: readonly K[]
): value is T & Record<K, string> {
  return keys.every(key => typeof value[key] === 'string');
}

function isStoredSession(value: unknown): value is StoredSession {
  return (
    isRecord(value) &&
    isStrings(value, ['session', 'callback', 'appSecretKey', 'appPublicKey', 'walletPublicKey']) &&
    isDAppMessage(value.request) &&
    isDAppMessage(value.permission)
  );
}

function isPending(value: unknown): value is Pending {
  if (!isRecord(value) || typeof value.sentAt !== 'number') return false;
  if (value.kind === 'request') return isStrings(value, ['id', 'session']);
  return (
    value.kind === 'connect' &&
    isDAppMessage(value.request) &&
    isRecord(value.connection) &&
    isStrings(value.connection, ['id', 'callback', 'appSecretKey', 'appPublicKey'])
  );
}

function isOutcome(value: unknown): value is TransactionOutcome {
  return isRecord(value) && ('output' in value || isRecord(value.error));
}
