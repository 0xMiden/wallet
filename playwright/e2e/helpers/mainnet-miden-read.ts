import { AccountId, BasicFungibleFaucetComponent, Endpoint, NoteId, RpcClient, Word } from '@miden-sdk/miden-sdk';

import { withRpcTimeout } from '../../../src/lib/miden-chain/rpc-timeout';

function publicRpc(rpcUrl: string): RpcClient {
  let url: URL;
  try { url = new URL(rpcUrl); } catch { throw new Error('Invalid public mainnet RPC URL'); }
  if (rpcUrl.length > 2048 || rpcUrl.trim() !== rpcUrl || url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid public mainnet RPC URL');
  return new RpcClient(new Endpoint(rpcUrl));
}

export async function readMainnetMidenBlock(rpcUrl: string): Promise<number> {
  const rpc = publicRpc(rpcUrl);
  const header = await withRpcTimeout(() => rpc.getBlockHeaderByNumber(undefined), 'mainnet header', { retries: 0 });
  const height = Number(header.blockNum());
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error('Invalid live mainnet block height');
  return height;
}

export async function verifyMainnetMidenNoteInclusion(
  rpcUrl: string, noteId: string, blockNumber: number, senderHex: string
): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/.test(noteId) || !/^0x[0-9a-f]{30}$/.test(senderHex) ||
      !Number.isSafeInteger(blockNumber) || blockNumber <= 0 || blockNumber > 0xffff_ffff)
    throw new Error('Invalid mainnet note inclusion scope');
  const rpc = publicRpc(rpcUrl);
  const header = await withRpcTimeout(() => rpc.getBlockHeaderByNumber(blockNumber), 'mainnet note header', { retries: 0 });
  const notes = await withRpcTimeout(() => rpc.getNotesById([NoteId.fromHex(noteId)]), 'mainnet note inclusion', { retries: 0 });
  const note = notes[0];
  if (notes.length !== 1 || !note || note.noteId.toString() !== noteId || note.metadata.sender().toString() !== senderHex ||
      header.blockNum() !== blockNumber || note.inclusionProof.location().blockNum() !== blockNumber)
    throw new Error('Mainnet note identity, sender or canonical block differs from its provider evidence');
  const index = note.inclusionProof.location().blockNoteTreeIndex();
  if (!Number.isSafeInteger(index) || index < 0 ||
      !note.inclusionProof.notePath().verify(BigInt(index), Word.fromHex(noteId), header.noteRoot()))
    throw new Error('Mainnet note is not proven under the actual canonical header root');
}

export async function readMainnetFaucetMetadata(
  faucetId: string, rpcUrl: string
): Promise<{ symbol: string; decimals: number }> {
  if (!/^0x[0-9a-f]{30}$/i.test(faucetId)) throw new Error('Invalid mainnet faucet identity');
  const rpc = publicRpc(rpcUrl);
  const details = await withRpcTimeout(() => rpc.getAccountDetails(AccountId.fromHex(faucetId)), 'mainnet faucet', { retries: 0 });
  const account = details.account();
  if (!account) throw new Error('Mainnet faucet has no public account state');
  const faucet = BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
  return { symbol: faucet.symbol().toString(), decimals: faucet.decimals() };
}
