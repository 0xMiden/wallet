-- Schema of the wallet-api D1 database.
-- Every query carries the profile_id from the JWT. A client cannot address another profile.

-- generation: 16 random bytes that the login writes when it creates the profile. A token carries the
-- generation of the profile it was issued for, so a token from before DELETE /v1/profile cannot read,
-- write or delete the profile a later login makes again.
CREATE TABLE profiles (
  profile_id      TEXT PRIMARY KEY,
  sync_public_key BLOB NOT NULL,
  salt            BLOB,
  generation      BLOB NOT NULL,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);

CREATE TABLE entries (
  profile_id TEXT NOT NULL,
  feature    TEXT NOT NULL,
  hashed_key BLOB NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  envelope   INTEGER NOT NULL,
  kdf_params INTEGER NOT NULL,
  blob       BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, feature, hashed_key)
);
CREATE INDEX entries_cursor ON entries (profile_id, feature, updated_at);

CREATE TABLE auth_nonces (
  public_key BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (public_key, nonce)
);
-- The expiry sweep of every nonce request reads this index, not the table.
CREATE INDEX auth_nonces_expiry ON auth_nonces (expires_at);
