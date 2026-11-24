import { getStorageProvider } from 'lib/platform/storage-adapter';

// A leaf, so the dApp permission store can end an origin's sessions without bundling the protocol package.
export const BREAD_CONNECT_SESSIONS_KEY = 'bread_connect_sessions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ends every Bread Connect session kept for `origin`, whose permission the user just removed in Bread. */
export async function endOriginSessions(origin: string): Promise<void> {
  const storage = getStorageProvider();
  const sessions: unknown = (await storage.get([BREAD_CONNECT_SESSIONS_KEY]))[BREAD_CONNECT_SESSIONS_KEY];
  if (!isRecord(sessions)) return;
  const kept = Object.entries(sessions).filter(([, session]) => !isRecord(session) || session.origin !== origin);
  await storage.set({ [BREAD_CONNECT_SESSIONS_KEY]: Object.fromEntries(kept) });
}
