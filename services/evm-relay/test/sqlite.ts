// The SQL interface of the Sender over node:sqlite, so the tests run the real statements on a real SQLite.
import { DatabaseSync } from 'node:sqlite';

import type { SqlDatabase } from '../src/sender';

export interface MemoryDatabase extends SqlDatabase {
  /** The connection, for checks of the stored rows. */
  db: DatabaseSync;
}

export function memoryDatabase(): MemoryDatabase {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    run: (query, ...bindings) => db.prepare(query).all(...bindings),
    transaction: closure => {
      db.exec('BEGIN');
      try {
        const result = closure();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
