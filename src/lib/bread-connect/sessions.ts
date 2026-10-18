import {
  isRecord,
  REQUEST_MAX_AGE_MS,
  REQUEST_MAX_CLOCK_AHEAD_MS,
  SESSION_IDLE_MS,
  type WalletSession
} from '@miden-sdk/bread-connect';
import { getAllDApps } from 'lib/miden/back/dapp';
import { getStorageProvider } from 'lib/platform/storage-adapter';

const STORAGE_KEY = 'bread_connect_sessions';
// A replayed link older than this fails the age check, so its id need not be remembered any longer.
const ANSWERED_MS = REQUEST_MAX_AGE_MS + REQUEST_MAX_CLOCK_AHEAD_MS;

export interface StoredSession extends WalletSession {
  usedAt: number;
  answered: { id: string; at: number }[];
}

type Sessions = Record<string, StoredSession>;

function isAnswered(value: unknown): value is { id: string; at: number } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.at === 'number';
}

function isStoredSession(value: unknown): value is StoredSession {
  return (
    isRecord(value) &&
    ['session', 'callback', 'origin', 'appPublicKey', 'walletSecretKey', 'walletPublicKey'].every(
      field => typeof value[field] === 'string'
    ) &&
    typeof value.usedAt === 'number' &&
    Array.isArray(value.answered) &&
    value.answered.every(isAnswered)
  );
}

async function readSessions(now: number): Promise<Sessions> {
  const value: unknown = (await getStorageProvider().get([STORAGE_KEY]))[STORAGE_KEY];
  if (!isRecord(value)) return {};
  const sessions: Sessions = {};
  for (const [id, session] of Object.entries(value)) {
    if (isStoredSession(session) && session.session === id && now - session.usedAt <= SESSION_IDLE_MS) {
      sessions[id] = session;
    }
  }
  return sessions;
}

async function writeSessions(sessions: Sessions): Promise<void> {
  await getStorageProvider().set({ [STORAGE_KEY]: sessions });
}

/** The session, unless it went unused for 30 days or the user removed its app's permission in Bread. */
export async function findSession(id: string, now: number): Promise<StoredSession | null> {
  const sessions = await readSessions(now);
  const session = sessions[id];
  if (!session) return null;
  if ((await getAllDApps())[session.origin]?.length) return session;
  delete sessions[id];
  await writeSessions(sessions);
  return null;
}

export async function keepSession(session: WalletSession, now: number): Promise<void> {
  const sessions = await readSessions(now);
  sessions[session.session] = { ...session, usedAt: now, answered: [] };
  await writeSessions(sessions);
}

/** Forgets a session Bread kept for an answer no app took. */
export async function dropSession(id: string, now: number): Promise<void> {
  const sessions = await readSessions(now);
  delete sessions[id];
  await writeSessions(sessions);
}

export function hasAnswered(session: StoredSession, requestId: string, now: number): boolean {
  return session.answered.some(answered => answered.id === requestId && now - answered.at <= ANSWERED_MS);
}

/** Marks the session used and `requestId` answered, so a link carrying that id again is refused. */
export async function recordAnswered(sessionId: string, requestId: string, now: number): Promise<void> {
  const sessions = await readSessions(now);
  const session = sessions[sessionId];
  if (!session) return;
  sessions[sessionId] = {
    ...session,
    usedAt: now,
    answered: [
      ...session.answered.filter(answered => answered.id !== requestId && now - answered.at <= ANSWERED_MS),
      { id: requestId, at: now }
    ]
  };
  await writeSessions(sessions);
}
