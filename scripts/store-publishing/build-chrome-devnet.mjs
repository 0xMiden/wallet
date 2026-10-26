import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function buildChromeDevnet({ dist = resolve('dist'), run } = {}) {
  const scratch = await mkdtemp(join(dirname(dist), '.chrome-networks-'));
  let backedUp = false;
  let completed = false;
  try {
    await cp(dist, join(scratch, 'original'), { recursive: true });
    backedUp = true;
    const build =
      run ??
      (async network => {
        const result = await exec('yarn', ['build:chrome'], {
          cwd: dirname(dist),
          env: { ...process.env, MIDEN_NETWORK: network },
          maxBuffer: 64 * 1024 * 1024
        });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        if (/(^|\s)error(:|\s)|compiled with [1-9][0-9]* errors?/im.test(result.stdout + result.stderr)) {
          throw new Error(`Chrome ${network} build output contains errors`);
        }
      });
    for (const network of ['testnet', 'devnet']) {
      await build(network);
      JSON.parse(await readFile(join(dist, 'chrome_unpacked/manifest.json'), 'utf8'));
      if ((await stat(join(dist, 'chrome.zip'))).size === 0) throw new Error(`Empty Chrome ${network} archive`);
      await cp(join(dist, 'chrome.zip'), join(scratch, `chrome-${network}.zip`));
      if (network === 'testnet')
        await cp(join(dist, 'chrome_unpacked'), join(scratch, 'chrome_unpacked'), { recursive: true });
    }
    completed = true;
  } finally {
    if (backedUp) {
      await rm(dist, { recursive: true, force: true });
      await cp(join(scratch, 'original'), dist, { recursive: true });
    }
    if (completed) {
      await mkdir(dist, { recursive: true });
      await rm(join(dist, 'chrome_unpacked'), { recursive: true, force: true });
      await cp(join(scratch, 'chrome_unpacked'), join(dist, 'chrome_unpacked'), { recursive: true });
      await cp(join(scratch, 'chrome-testnet.zip'), join(dist, 'chrome.zip'));
      for (const network of ['testnet', 'devnet'])
        await cp(join(scratch, `chrome-${network}.zip`), join(dist, `chrome-${network}.zip`));
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildChromeDevnet().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
