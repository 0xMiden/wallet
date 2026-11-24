'use strict';

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

// A stuck reporting write may lose its evidence. Financial wait/ready files still use the original command's result.
spawnSync(process.execPath, [join(__dirname, 'job.cjs'), ...process.argv.slice(2)], {
  timeout: 500,
  killSignal: 'SIGKILL',
  stdio: 'ignore'
});
