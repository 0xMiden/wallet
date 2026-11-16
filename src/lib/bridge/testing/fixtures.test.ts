/** @jest-environment node */
import { BridgedSendTransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import './fixtures';

interface BinaryGraph {
  bytes: Uint8Array;
  alias: Uint8Array;
  amount: bigint;
  references: Map<string, Uint8Array>;
  self?: BinaryGraph;
}

afterEach(() => Repo.transactions.clear());

it('clones real realm-local binary and preserves original and current bytes through Dexie modify', async () => {
  const bytes = new Uint8Array([81, 82]);
  const graph: BinaryGraph = {
    bytes,
    alias: bytes,
    amount: 9_007_199_254_740_993n,
    references: new Map([['bytes', bytes]])
  };
  graph.self = graph;
  const cloned = structuredClone(graph);
  expect(cloned.bytes).toBeInstanceOf(Uint8Array);
  expect(cloned.bytes).toEqual(bytes);
  expect(cloned.bytes.buffer).not.toBe(bytes.buffer);
  expect(cloned.alias).toBe(cloned.bytes);
  expect(cloned.references.get('bytes')).toBe(cloned.bytes);
  expect(cloned.self).toBe(cloned);
  expect(cloned.amount).toBe(graph.amount);

  const row = new BridgedSendTransaction('account', graph.amount, '0xrecipient', 1, 'epoch', 'faucet', bytes);
  row.extraInputs.epochCollateralRequestBytes = new Uint8Array(bytes);
  await Repo.transactions.put(row);
  const stored = await Repo.transactions.get(row.id);
  expect(stored?.requestBytes).toBeInstanceOf(Uint8Array);
  expect(stored?.extraInputs.epochCollateralRequestBytes).toBeInstanceOf(Uint8Array);
  expect(stored?.requestBytes?.buffer).not.toBe(bytes.buffer);
  await Repo.transactions.where({ id: row.id }).modify(value => {
    value.status = ITransactionStatus.Completed;
  });
  const modified = await Repo.transactions.get(row.id);
  expect(modified?.requestBytes).toBeInstanceOf(Uint8Array);
  expect(modified?.requestBytes).toEqual(bytes);
  expect(modified?.extraInputs.epochCollateralRequestBytes).toBeInstanceOf(Uint8Array);
  expect(modified?.extraInputs.epochCollateralRequestBytes).toEqual(bytes);
  expect(modified?.extraInputs.epochCollateralRequestBytes?.buffer).not.toBe(bytes.buffer);
  expect(modified?.amount).toBe(graph.amount);
});
