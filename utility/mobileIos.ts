const { spawnSync } = require('child_process') as typeof import('child_process');

const args = process.argv.slice(2);
let includeSwapForIos = false;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];

  if (argument !== '--includeSwapForIos') {
    throw new Error(`Unknown option: ${argument}`);
  }

  const value = args[index + 1];
  if (value !== 'true' && value !== 'false') {
    throw new Error('--includeSwapForIos must be followed by true or false');
  }

  // Internal testing only. Production/release builds must leave this false.
  includeSwapForIos = value === 'true';
  index += 1;
}

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, commandArgs, { env, stdio: 'inherit' });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('yarn', ['mobile:sync'], {
  ...process.env,
  MIDEN_INCLUDE_SWAP_FOR_IOS: String(includeSwapForIos)
});
run('npx', ['cap', 'open', 'ios']);
