// Makes the local relayer key, or reads its address. The key stays in `services/evm-relay/.dev.vars` (Git ignores
// that file). This script never prints the key: it prints only the address, which is the executor of the relay.
//
// Usage:
//   node scripts/dev/relay-local/relayer-key.mjs new [--dev-vars <path>]
//     Makes a new random key and writes it as RELAYER_PRIVATE_KEY. When the file does not exist, it starts from
//     services/evm-relay/.dev.vars.example. It refuses to replace a valid key that is already in the file.
//   node scripts/dev/relay-local/relayer-key.mjs address [--dev-vars <path>]
//     Prints the address of RELAYER_PRIVATE_KEY.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { generatePrivateKey } from 'viem/accounts';

import { DEFAULT_DEV_VARS, REPO_ROOT, readDevVars, relayerAddressOf } from './lib.mjs';

const EXAMPLE = join(REPO_ROOT, 'services/evm-relay/.dev.vars.example');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'dev-vars': { type: 'string' } }
});
const path = values['dev-vars'] ?? process.env.RELAY_DEV_VARS ?? DEFAULT_DEV_VARS;

function fail(message) {
  console.error(`relayer-key: ${message}`);
  process.exit(1);
}

switch (positionals[0]) {
  case 'address': {
    const address = relayerAddressOf(readDevVars(path));
    if (address === null) fail(`no valid RELAYER_PRIVATE_KEY in ${path}`);
    console.log(address);
    break;
  }
  case 'new': {
    if (relayerAddressOf(readDevVars(path)) !== null) {
      fail(`${path} has a valid RELAYER_PRIVATE_KEY already. Remove that line first to make a new key.`);
    }
    const text = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(EXAMPLE, 'utf8');
    const line = `RELAYER_PRIVATE_KEY=${generatePrivateKey()}`;
    const pattern = /^\s*RELAYER_PRIVATE_KEY\s*=.*$/m;
    const next = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
    writeFileSync(path, next, { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`Wrote a new RELAYER_PRIVATE_KEY to ${path} (mode 0600).`);
    console.log(`Relayer address (executor): ${relayerAddressOf(readDevVars(path))}`);
    break;
  }
  default:
    fail('usage: relayer-key.mjs new | address [--dev-vars <path>]');
}
