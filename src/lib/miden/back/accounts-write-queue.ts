import PQueue from 'p-queue';

// Single-writer serializer for any mutation that reads the accounts list and
// writes it back. Those read-modify-write pairs straddle a WASM round-trip or
// an encrypt/save, so two of them racing means the later write silently drops
// the earlier one's account (see `importAccountFromPrivateKey` in actions.ts).
//
// Historically this lived in actions.ts as `_unlockQueue`, shared by unlock and
// account import. It sits in its own leaf module so the detached Guardian
// note-recovery can join the same queue for its terminal flag write without
// importing actions.ts, which imports the recovery module in turn.
//
// Lazy init: in the Vite SW build, module-scope init may not complete because
// actions.ts transitively imports frontend modules that hang in SW context, so
// the queue has to be available on first use either way.
let queue: PQueue | undefined;

export function getAccountsWriteQueue(): PQueue {
  if (!queue) queue = new PQueue({ concurrency: 1 });
  return queue;
}
