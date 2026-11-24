import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;

export function sampleResources({
  shard = 'unknown',
  workspace = process.cwd(),
  now = () => new Date(),
  run = (command, args) =>
    spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000
    }),
  output = process.stdout
}) {
  const timestamp = now().toISOString();
  output.write(`coverage-resource-sample shard=${shard} timestamp=${timestamp}\n`);

  for (const [command, args] of [
    ['free', ['-m']],
    ['df', ['-h', workspace]]
  ]) {
    let result;
    try {
      result = run(command, args);
    } catch (error) {
      output.write(`${command} ${args.join(' ')} failed: ${error.message}\n`);
      continue;
    }

    output.write(`${command} ${args.join(' ')} exit=${result.status ?? 'unknown'}\n`);
    if (result.stdout) output.write(result.stdout);
    if (result.stderr) output.write(result.stderr);
    if (result.error) output.write(`${command} error: ${result.error.message}\n`);
  }
}

export function startResourceSampler({
  shard,
  workspace,
  sample = () => sampleResources({ shard, workspace }),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  let stopped = false;
  sample();
  const interval = setIntervalFn(sample, DEFAULT_SAMPLE_INTERVAL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(interval);
  };
}

function startSamplerProcess() {
  const stop = startResourceSampler({
    shard: process.argv[2] ?? process.env.SHARD ?? 'unknown',
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd()
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startSamplerProcess();
}
