import {
  database,
  entryStatement,
  entryView,
  featureEntriesStatement,
  featureMetadataStatement,
  profileStatement,
  saltHexOf,
  writeEntries
} from '../db';
import { ApiError } from '../errors';
import { featureEtag, profileEtag } from '../etag';
import { ifNoneMatch, json, notModified, readJson } from '../http';
import { batchWriteCost, limitStorage } from '../rate-limit';
import { parseEntryRow, parseMetadataRow, parseProfileMetadataRow, resultAt } from '../rows';
import type { ProfileMetadataRow } from '../rows';
import { PROFILE_METADATA } from '../sql';
import { authenticate } from '../token';
import type { BatchWriteResponse, EntryView, Feature, FeatureRead, RequestContext, StorageRead } from '../types';
import { parseBatch, parseEntry, parseReadPage } from '../validate';

/** Return the full-profile ETag and the ETag of every feature. Read no blob. */
export async function readStorage(context: RequestContext): Promise<Response> {
  const db = database(context.env);
  const principal = await authenticate(context);
  await limitStorage(context, principal, 'read');
  const { profileId } = principal;
  const results = await db.batch([profileStatement(db, profileId), db.prepare(PROFILE_METADATA).bind(profileId)]);
  const saltHex = saltHexOf(resultAt(results, 0), principal);
  const rows = resultAt(results, 1)
    .results.map(parseProfileMetadataRow)
    .filter((row): row is ProfileMetadataRow => row !== null);
  const etag = await profileEtag(saltHex, rows);
  if (ifNoneMatch(context.request)?.has(etag)) return notModified(etag);
  const etagOf = async (feature: Feature): Promise<{ etag: string }> => ({
    etag: await featureEtag(saltHex, rows.filter(row => row.feature === feature))
  });
  const features: StorageRead['features'] = {
    accounts: await etagOf('accounts'),
    contacts: await etagOf('contacts'),
    history: await etagOf('history')
  };
  const body: StorageRead = { etag, features };
  return json(body, 200, { ETag: `"${etag}"` });
}

/**
 * One page of a feature. The ETag is always the one of the complete feature,
 * computed from the metadata of every entry, which carries no blob. The page
 * holds at most `limit` entries; `next` names the key the next page starts
 * after. The 304 is decided from the same metadata before any blob is read.
 */
export async function readFeature(context: RequestContext, feature: Feature): Promise<Response> {
  const db = database(context.env);
  const principal = await authenticate(context);
  await limitStorage(context, principal, 'read');
  const { profileId } = principal;
  const page = parseReadPage(context.url);
  // The salt and the metadata come from one batch, so the ETag is one snapshot.
  // The page is read only after the ETag check, so a 304 reads no blob.
  // A write between the two reads makes the page newer than the ETag. That is
  // safe: the next conditional read then returns 200 again, nothing is missed.
  const results = await db.batch([profileStatement(db, profileId), featureMetadataStatement(db, profileId, feature)]);
  const saltHex = saltHexOf(resultAt(results, 0), principal);
  const metadata = resultAt(results, 1).results.map(parseMetadataRow);
  const etag = await featureEtag(saltHex, metadata);
  if (ifNoneMatch(context.request)?.has(etag)) return notModified(etag);
  const pageResult = await featureEntriesStatement(db, profileId, feature, page).all();
  const rows = pageResult.results.map(row => entryView(parseEntryRow(row)));
  const entries: EntryView[] = rows.slice(0, page.limit);
  const last = entries[entries.length - 1];
  const next = rows.length > page.limit && last !== undefined ? last.hashedKey : null;
  const body: FeatureRead = { etag, entries, next };
  return json(body, 200, { ETag: `"${etag}"` });
}

export async function readEntry(context: RequestContext, feature: Feature, hashedKey: string): Promise<Response> {
  const db = database(context.env);
  const principal = await authenticate(context);
  await limitStorage(context, principal, 'read');
  const { profileId } = principal;
  const results = await db.batch([profileStatement(db, profileId), entryStatement(db, profileId, feature, hashedKey)]);
  saltHexOf(resultAt(results, 0), principal);
  const [row] = resultAt(results, 1).results;
  if (row === undefined) throw new ApiError(404, 'not_found', 'The entry does not exist.');
  return json(entryView(parseEntryRow(row)));
}

export async function writeEntry(context: RequestContext, feature: Feature, hashedKey: string): Promise<Response> {
  const db = database(context.env);
  const principal = await authenticate(context);
  await limitStorage(context, principal, 'write');
  const entry = parseEntry(await readJson(context.request), feature);
  const [acknowledgement] = await writeEntries(db, principal, feature, [{ hashedKey, entry }]);
  if (!acknowledgement) throw new Error('Missing write acknowledgement');
  return json(acknowledgement);
}

export async function writeBatch(context: RequestContext, feature: Feature): Promise<Response> {
  const db = database(context.env);
  const principal = await authenticate(context);
  const items = parseBatch(await readJson(context.request), feature);
  await limitStorage(context, principal, 'write', batchWriteCost(items.length));
  const body: BatchWriteResponse = { entries: await writeEntries(db, principal, feature, items) };
  return json(body);
}
