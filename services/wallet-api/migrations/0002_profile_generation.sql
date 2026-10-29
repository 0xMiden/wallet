-- The profile generation: 16 random bytes that the login writes when it creates the profile.
-- A token carries the generation of the profile it was issued for. A profile that DELETE /v1/profile
-- removed and a later login made again has a new generation, so an older token cannot read it,
-- write to it or delete it.
ALTER TABLE profiles ADD COLUMN generation BLOB NOT NULL DEFAULT X'00';
UPDATE profiles SET generation = randomblob(16) WHERE generation = X'00';
