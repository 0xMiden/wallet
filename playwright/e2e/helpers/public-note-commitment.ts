import type { Endpoint, NoteId, RpcClient } from '@miden-sdk/miden-sdk';
import { execFile } from 'child_process';
import * as path from 'path';

const sdk = {
  getNotesById: 'getNotesById' satisfies keyof RpcClient,
  fromHex: 'fromHex' satisfies keyof typeof NoteId,
  endpoint: 'Endpoint' satisfies typeof Endpoint.name
};

const query = `
import { RpcClient, Endpoint, NoteId } from '@miden-sdk/miden-sdk';
const rpc = new RpcClient(new ${sdk.endpoint}(process.argv[1]));
const noteId = NoteId.${sdk.fromHex}(process.argv[2]);
const timeoutMs = Number(process.argv[3]);
const deadline = Date.now() + timeoutMs;
for (;;) {
  const notes = await rpc.${sdk.getNotesById}([noteId]);
  if (notes.some(note => note.noteId.toString() === noteId.toString() && note.asInputNote())) {
    console.log('committed');
    break;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Public faucet note did not commit within ' + timeoutMs + 'ms');
  await new Promise(resolve => setTimeout(resolve, Math.min(2000, remaining)));
}
`;

/** The public faucet returns a queued note; verify that exact public note is on chain before consuming. */
export async function waitForPublicNoteCommitment(
  rpcUrl: string,
  noteId: string,
  timeoutMs = 180_000,
  sdkRoot = path.resolve(__dirname, '../../..')
): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/i.test(noteId)) throw new Error('Public faucet returned an invalid note ID');
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', query, rpcUrl, noteId, String(timeoutMs)],
      { cwd: sdkRoot, timeout: timeoutMs + 5_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
  if (output.trim() !== 'committed') throw new Error('Public faucet commitment query returned no proof');
}
