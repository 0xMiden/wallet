import { Address } from '@miden-sdk/miden-sdk';
import { isRecord } from '../../../src/lib/update/guards';

export interface MainnetMidenOutputCandidates {
  transactionId: string;
  senderAddress: string;
  senderHex: string;
  blockNumber: number;
  noteIds: string[];
}
// shortcut: pinned official explorer backend, update from its mainnet runtime config if the endpoint changes.
const INDEXER = 'https://scan-backend-cedar-miden.eu-central-8.gateway.fm/graphql';
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
async function read(query: string, variables: Record<string, string>, fetcher: typeof fetch): Promise<unknown> {
  try {
    const response = await fetcher(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body)
      throw new Error('Invalid indexer response');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let body = '';
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_048_576) { await reader.cancel(); throw new Error('Oversized indexer response'); }
        body += decoder.decode(next.value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
    const result: unknown = JSON.parse(body);
    if (!isRecord(result) || (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length)))
      throw new Error('Indexer returned lookup errors');
    return result.data;
  } catch { throw new Error('Public mainnet maker lookup failed; no settlement inferred'); }
}
function makerLocation(senderAddress: unknown, blockText: unknown) {
  if (typeof senderAddress !== 'string' || !/^mm1[a-z0-9]{20,150}$/.test(senderAddress) ||
      typeof blockText !== 'string' || !/^[1-9]\d{0,9}$/.test(blockText)) throw new Error('Invalid maker block identity');
  const senderHex = Address.fromBech32(senderAddress).accountId().toString();
  const blockNumber = Number(blockText);
  if (!/^0x[0-9a-f]{30}$/.test(senderHex) || blockNumber > 0xffff_ffff) throw new Error('Invalid mainnet maker location');
  return { senderAddress, senderHex, blockText, blockNumber };
}
async function makerOutputs(
  location: ReturnType<typeof makerLocation>, fetcher: typeof fetch
): Promise<MainnetMidenOutputCandidates> {
  const { senderAddress, senderHex, blockText, blockNumber } = location;
  // The official indexer exposes no direct tx-note links; any second transaction makes this association ambiguous.
  const found = await read(`query($account:String!,$height:BigIntNumber!){
    transactions(first:2,input:{account_bech:$account,block_number:$height,order_by:asc,sort_by:timestamp}){
      edges{node{transaction_id account_bech block_number}} pageInfo{hasNextPage}}
    notes(first:100,input:{sender:$account,block_number:$height,order_by:asc,sort_by:timestamp}){
      edges{node{note_id sender block_number}} pageInfo{hasNextPage}}}`,
    { account: senderAddress, height: blockText }, fetcher);
  if (!isRecord(found) || !isRecord(found.transactions) || !Array.isArray(found.transactions.edges) || found.transactions.edges.length !== 1 ||
      !isRecord(found.transactions.pageInfo) || found.transactions.pageInfo.hasNextPage !== false ||
      !isRecord(found.notes) || !Array.isArray(found.notes.edges) || found.notes.edges.length > 100 ||
      !isRecord(found.notes.pageInfo) || found.notes.pageInfo.hasNextPage !== false)
    throw new Error('Maker transaction or note history is ambiguous or truncated');
  const edge: unknown = found.transactions.edges[0];
  if (!isRecord(edge) || !isRecord(edge.node) || !hash(edge.node.transaction_id) ||
      edge.node.account_bech !== senderAddress || edge.node.block_number !== blockText)
    throw new Error('Exact unique maker transaction was not found');
  const transactionId = edge.node.transaction_id;
  const noteIds: string[] = [];
  for (const entry of found.notes.edges) {
    if (!isRecord(entry) || !isRecord(entry.node) || !hash(entry.node.note_id) || entry.node.sender !== senderAddress ||
        entry.node.block_number !== blockText || noteIds.includes(entry.node.note_id))
      throw new Error('Maker output candidate identity is inconsistent');
    noteIds.push(entry.node.note_id);
  }
  return { transactionId, senderAddress, senderHex, blockNumber, noteIds };
}
export async function readMainnetMidenOwnNoteCreator(
  noteId: string, walletAccountHex: string, fetcher: typeof fetch = fetch
): Promise<MainnetMidenOutputCandidates> {
  if (!hash(noteId) || !/^0x[0-9a-f]{30}$/.test(walletAccountHex)) throw new Error('Invalid original note creator scope');
  const initial = await read('query($id:DigestString!){note(input:{note_id:$id}){note_id sender block_number}}', { id: noteId }, fetcher);
  if (!isRecord(initial) || !isRecord(initial.note) || initial.note.note_id !== noteId) throw new Error('Exact original note not found');
  const location = makerLocation(initial.note.sender, initial.note.block_number);
  if (location.senderHex !== walletAccountHex) throw new Error('Original note was not created by the funded wallet');
  const found = await makerOutputs(location, fetcher);
  if (!found.noteIds.includes(noteId)) throw new Error('Original note is missing from its actual maker block');
  return found;
}
export async function readMainnetMidenOutputCandidates(
  transactionId: string, walletAccountHex: string, fetcher: typeof fetch = fetch
): Promise<MainnetMidenOutputCandidates> {
  if (!hash(transactionId) || !/^0x[0-9a-f]{30}$/.test(walletAccountHex)) throw new Error('Invalid maker receipt scope');
  const initial = await read('query($id:DigestString!){transaction(input:{transaction_id:$id}){transaction_id account_bech block_number}}',
    { id: transactionId }, fetcher);
  if (!isRecord(initial) || !isRecord(initial.transaction) || initial.transaction.transaction_id !== transactionId)
    throw new Error('Missing exact maker transaction');
  const location = makerLocation(initial.transaction.account_bech, initial.transaction.block_number);
  if (location.senderHex === walletAccountHex) throw new Error('Maker receipt is self-funded');
  const found = await makerOutputs(location, fetcher);
  if (found.transactionId !== transactionId) throw new Error('Exact unique provider transaction was not found');
  return found;
}
