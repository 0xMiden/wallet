/** @jest-environment node */
import { readMainnetMidenOutputCandidates } from '../playwright/e2e/helpers/mainnet-miden-indexer';
jest.mock('@miden-sdk/miden-sdk', () => ({ Address: { fromBech32: () => ({ accountId: () => ({ toString: () => '0x593c167bec26769178dcbd1f9bcb40' }) }) } }));
const txId = `0x${'a'.repeat(64)}`; const noteId = `0x${'b'.repeat(64)}`;
const sender = 'mm1apeg8ae87qy4n52a2myu6kpk8c3y4mav'; const senderHex = '0x593c167bec26769178dcbd1f9bcb40';
const self = `0x${'11'.repeat(15)}`;
const transaction = () => ({ transaction_id: txId, account_bech: sender, block_number: '828100' });
const reply = () => ({ data: { transactions: { edges: [{ node: transaction() }], pageInfo: { hasNextPage: false } },
  notes: { edges: [{ node: { note_id: noteId, sender, block_number: '828100' } }], pageInfo: { hasNextPage: false } } } });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const fetcher = jest.fn();
beforeEach(() => { jest.clearAllMocks(); fetcher.mockReset().mockResolvedValueOnce(json({ data: { transaction: transaction() } }))
  .mockResolvedValueOnce(json(reply())); });
it('returns only candidates from the exact non-self maker transaction and its unique actor/block, never an amount match', async () => {
  await expect(readMainnetMidenOutputCandidates(txId, self, fetcher)).resolves.toEqual({ transactionId: txId,
    senderAddress: sender, senderHex, blockNumber: 828100, noteIds: [noteId] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const request = JSON.parse(fetcher.mock.calls[1]?.[1].body);
  expect(request.variables).toEqual({ account: sender, height: '828100' });
});
it('rejects self-funded provider transaction metadata before scanning notes', async () => {
  await expect(readMainnetMidenOutputCandidates(txId, senderHex, fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects a different transaction returned for the exact provider hash', async () => {
  fetcher.mockReset().mockResolvedValue(json({ data: { transaction: { ...transaction(), transaction_id: noteId } } }));
  await expect(readMainnetMidenOutputCandidates(txId, self, fetcher)).rejects.toThrow();
});
const invalid: [string, (value: ReturnType<typeof reply>) => void][] = [
  ['two maker transactions in one block', value => { value.data.transactions.edges.push({ node: { ...transaction(), transaction_id: noteId } }); }],
  ['truncated maker transaction history', value => { value.data.transactions.pageInfo.hasNextPage = true; }],
  ['truncated note history', value => { value.data.notes.pageInfo.hasNextPage = true; }],
  ['foreign note sender', value => { value.data.notes.edges[0]!.node.sender = 'mm1another'; }],
  ['foreign note block', value => { value.data.notes.edges[0]!.node.block_number = '828101'; }],
  ['duplicate note IDs', value => { value.data.notes.edges.push(value.data.notes.edges[0]!); }],
  ['another transaction in the alleged unique slot', value => { value.data.transactions.edges[0]!.node.transaction_id = noteId; }]
];
it.each(invalid)('refuses %s rather than guessing which payment belongs to the quote', async (_name, change) => {
  const changed = reply(); change(changed); fetcher.mockReset()
    .mockResolvedValueOnce(json({ data: { transaction: transaction() } }))
    .mockResolvedValueOnce(json(changed));
  await expect(readMainnetMidenOutputCandidates(txId, self, fetcher)).rejects.toThrow();
});
it('refuses invalid provider fingerprints without contacting an indexer', async () => {
  await expect(readMainnetMidenOutputCandidates('not-a-hash', self, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
