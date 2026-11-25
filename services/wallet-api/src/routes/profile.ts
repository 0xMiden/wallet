import { database, profileStatement } from '../db';
import { bytesToHex, hexToBytes } from '../encoding';
import { ApiError, profileGone } from '../errors';
import { emptyResponse, json, readJson } from '../http';
import { limitStorage } from '../rate-limit';
import { parseProfileStateRow, parseSaltRow, resultAt } from '../rows';
import { DELETE_ENTRIES_OF_GENERATION, DELETE_PROFILE_OF_GENERATION, SET_SALT } from '../sql';
import { authenticate } from '../token';
import type { RequestContext, SaltResponse } from '../types';
import { parseSaltRequest } from '../validate';

/**
 * Set the profile salt once. A second set gets 409 with the stored salt. A token
 * of a profile that is deleted, or made again since, gets 401.
 */
export async function setSalt(context: RequestContext): Promise<Response> {
  const db = database(context.env);
  const principal = await authenticate(context);
  await limitStorage(context, principal, 'write');
  const { salt } = parseSaltRequest(await readJson(context.request));
  const updated = await db
    .prepare(SET_SALT)
    .bind(hexToBytes(salt), principal.profileId, hexToBytes(principal.generation))
    .first();
  const written = updated === null ? null : parseSaltRow(updated).salt;
  if (written !== null) {
    const body: SaltResponse = { salt: bytesToHex(written) };
    return json(body);
  }
  const row = await profileStatement(db, principal.profileId).first();
  if (row === null) throw profileGone();
  const stored = parseProfileStateRow(row);
  if (bytesToHex(stored.generation) !== principal.generation) throw profileGone();
  if (stored.salt === null) throw new Error('Salt write lost a race');
  throw new ApiError(409, 'salt_already_set', 'The profile salt is already set.', { salt: bytesToHex(stored.salt) });
}

/**
 * Delete the profile and all its entries in one batch. Both statements carry the
 * token's generation, so a token of an older generation deletes nothing and
 * gets 401: the check and the delete are one database operation.
 */
export async function deleteProfile(context: RequestContext): Promise<Response> {
  const db = database(context.env);
  const principal = await authenticate(context);
  await limitStorage(context, principal, 'write');
  const generation = hexToBytes(principal.generation);
  const results = await db.batch([
    db.prepare(DELETE_ENTRIES_OF_GENERATION).bind(principal.profileId, generation),
    db.prepare(DELETE_PROFILE_OF_GENERATION).bind(principal.profileId, generation)
  ]);
  if (resultAt(results, 1).meta.changes === 0) throw profileGone();
  return emptyResponse(204);
}
