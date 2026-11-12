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
export async function readMainnetMidenOutputCandidates(
  transactionId: string, walletAccountHex: string, fetcher: typeof fetch = fetch
): Promise<MainnetMidenOutputCandidates> {
  if (!hash(transactionId) || !/^0x[0-9a-f]{30}$/.test(walletAccountHex)) throw new Error('Invalid maker receipt scope');
  const initial = await read('query($id:DigestString!){transaction(input:{transaction_id:$id}){transaction_id account_bech block_number}}',
    { id: transactionId }, fetcher);
  if (!isRecord(initial) || !isRecord(initial.transaction)) throw new Error('Missing exact maker transaction');
  const tx = initial.transaction;
  if (tx.transaction_id !== transactionId || typeof tx.account_bech !== 'string' || !/^mm1[a-z0-9]{20,150}$/.test(tx.account_bech) ||
      typeof tx.block_number !== 'string' || !/^[1-9]\d{0,9}$/.test(tx.block_number)) throw new Error('Maker transaction identity is inconsistent');
  const senderAddress = tx.account_bech; const blockNumber = Number(tx.block_number);
  const senderHex = Address.fromBech32(senderAddress).accountId().toString();
  if (!/^0x[0-9a-f]{30}$/.test(senderHex) || senderHex === walletAccountHex || blockNumber > 0xffff_ffff)
    throw new Error('Maker receipt is self-funded or outside the supported chain');
  // The official indexer exposes no direct tx-note links; any second transaction makes this association ambiguous.
  const found = await read(`query($account:String!,$height:BigIntNumber!){
    transactions(first:2,input:{account_bech:$account,block_number:$height,order_by:asc,sort_by:timestamp}){
      edges{node{transaction_id account_bech block_number}} pageInfo{hasNextPage}}
    notes(first:100,input:{sender:$account,block_number:$height,order_by:asc,sort_by:timestamp}){
      edges{node{note_id sender block_number}} pageInfo{hasNextPage}}}`,
    { account: senderAddress, height: tx.block_number }, fetcher);
  if (!isRecord(found) || !isRecord(found.transactions) || !Array.isArray(found.transactions.edges) || found.transactions.edges.length !== 1 ||
      !isRecord(found.transactions.pageInfo) || found.transactions.pageInfo.hasNextPage !== false ||
      !isRecord(found.notes) || !Array.isArray(found.notes.edges) || found.notes.edges.length > 100 ||
      !isRecord(found.notes.pageInfo) || found.notes.pageInfo.hasNextPage !== false)
    throw new Error('Maker transaction or note history is ambiguous or truncated');
  const edge: unknown = found.transactions.edges[0];
  if (!isRecord(edge) || !isRecord(edge.node) || edge.node.transaction_id !== transactionId ||
      edge.node.account_bech !== senderAddress || edge.node.block_number !== tx.block_number)
    throw new Error('Exact unique maker transaction was not found');
  const noteIds: string[] = [];
  for (const entry of found.notes.edges) {
    if (!isRecord(entry) || !isRecord(entry.node) || !hash(entry.node.note_id) || entry.node.sender !== senderAddress ||
        entry.node.block_number !== tx.block_number || noteIds.includes(entry.node.note_id))
      throw new Error('Maker output candidate identity is inconsistent');
    noteIds.push(entry.node.note_id);
  }
  return { transactionId, senderAddress, senderHex, blockNumber, noteIds };
}
