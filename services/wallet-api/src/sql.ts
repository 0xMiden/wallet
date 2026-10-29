// The SQL text of the writes that carry the contract rules.

// The database clock in Unix ms. julianday works on every SQLite version that D1 runs.
const DB_NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

// One upsert per entry. The CASE writes revision 0 on a refused insert.
// The CHECK (revision >= 1) then fails, and D1 rolls back the full batch.
// A refused insert is an insert while the salt is NULL, an insert from a token of another
// profile generation, or a new key in a full feature.
// updated_at is the larger of the database clock and the largest updated_at of the profile.
export const UPSERT_ENTRY = `
INSERT INTO entries (profile_id, feature, hashed_key, revision, envelope, kdf_params, blob, updated_at)
VALUES (
  ?1, ?2, ?3,
  CASE
    WHEN EXISTS (SELECT 1 FROM profiles WHERE profile_id = ?1 AND salt IS NOT NULL AND generation = ?8)
     AND (
       EXISTS (SELECT 1 FROM entries WHERE profile_id = ?1 AND feature = ?2 AND hashed_key = ?3)
       OR (SELECT COUNT(*) FROM entries WHERE profile_id = ?1 AND feature = ?2) < ?7
     )
    THEN 1
    ELSE 0
  END,
  ?4, ?5, ?6,
  MAX(${DB_NOW_MS}, (SELECT COALESCE(MAX(updated_at), 0) FROM entries WHERE profile_id = ?1))
)
ON CONFLICT (profile_id, feature, hashed_key) DO UPDATE SET
  revision = entries.revision + 1, envelope = excluded.envelope, kdf_params = excluded.kdf_params,
  blob = excluded.blob, updated_at = excluded.updated_at
RETURNING revision, updated_at`;

// A new profile takes the generation the login proposes (?4). A profile that exists keeps its own.
export const UPSERT_PROFILE = `
INSERT INTO profiles (profile_id, sync_public_key, salt, generation, created_at, last_seen_at)
VALUES (?1, ?2, NULL, ?4, ?3, ?3)
ON CONFLICT (profile_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
RETURNING sync_public_key, salt, generation`;

// Spend a nonce. One statement is atomic, so two logins that race on one nonce get one row between them.
export const SPEND_NONCE =
  'DELETE FROM auth_nonces WHERE public_key = ? AND nonce = ? AND expires_at > ? RETURNING nonce';

// The generation check is in the statement: a token of a removed generation sets nothing.
export const SET_SALT =
  'UPDATE profiles SET salt = ?1 WHERE profile_id = ?2 AND generation = ?3 AND salt IS NULL RETURNING salt';

// The two statements of a profile delete. Both carry the generation, so a token of an older
// generation deletes nothing: the entries statement checks it with EXISTS, the profiles statement
// in its WHERE. The route reads the changes of the second one.
export const DELETE_ENTRIES_OF_GENERATION = `
DELETE FROM entries WHERE profile_id = ?1
  AND EXISTS (SELECT 1 FROM profiles WHERE profile_id = ?1 AND generation = ?2)`;
export const DELETE_PROFILE_OF_GENERATION = 'DELETE FROM profiles WHERE profile_id = ?1 AND generation = ?2';

export const PROFILE_STATE = 'SELECT salt, generation FROM profiles WHERE profile_id = ?';

export const ENTRY_COLUMNS = 'SELECT hashed_key, revision, envelope, kdf_params, blob, updated_at FROM entries';

export const PROFILE_METADATA =
  'SELECT feature, hashed_key, revision FROM entries WHERE profile_id = ? ORDER BY feature, hashed_key';
