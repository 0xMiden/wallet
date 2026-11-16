import { writeClosedSetupFailure } from './published-wasm-startup-preflight.ts';

try {
  writeClosedSetupFailure();
} catch {
  process.exit(1);
}
