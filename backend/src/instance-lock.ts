import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Keep this file in place. SQLite releases its lock when the process stops. */
export function acquireInstanceLock(dbPath: string): DatabaseSync {
  if (dbPath === ':memory:') {
    throw new Error('The server requires a persistent DB_PATH');
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const lock = new DatabaseSync(`${dbPath}.lock.sqlite`);
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    return lock;
  } catch {
    lock.close();
    throw new Error('Cannot lock the backend database. Stop the other instance and check storage permissions.');
  }
}
