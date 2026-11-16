import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export async function awaitMainnetLoopAuthorization(
  checkpointPath: string,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  const digest = () => {
    const file = statSync(checkpointPath);
    if (!file.isFile() || file.size < 1 || file.size > 65_536)
      throw new Error('Invalid mainnet authorization file size');
    return createHash('sha256').update(readFileSync(checkpointPath)).digest('hex');
  };
  if (signal.aborted) throw new Error('Mainnet authorization wait aborted');
  if (existsSync(gatePath)) throw new Error('Mainnet authorization release already exists');
  const expected = digest();
  writeFileSync(`${gatePath}.ready`, `${expected}\n`, { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (signal.aborted) throw new Error('Mainnet authorization wait aborted');
    if (Date.now() >= deadline) throw new Error('Mainnet authorization upload timed out');
    if (existsSync(gatePath)) {
      if (statSync(gatePath).size !== 65 || readFileSync(gatePath, 'utf8') !== `${expected}\n`)
        throw new Error('Uploaded mainnet authorization digest does not match');
      if (digest() !== expected) throw new Error('Mainnet authorization changed after readiness');
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
}
