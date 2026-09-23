/**
 * Loads the bundled register-domain note script.
 */

import { NoteScript } from '@miden-sdk/miden-sdk/lazy';

import { MidenNameScriptMismatchError } from './errors';
import { REGISTER_DOMAIN_SCRIPT_B64, REGISTER_DOMAIN_SCRIPT_ROOT_HEX } from './register-domain-script';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Deserialize the register-domain note script and make sure that its MAST root
 * is the root that the registry allows. Each call returns a NEW `NoteScript`,
 * because a wasm call that takes the script moves it into Rust.
 *
 * Throws MidenNameScriptMismatchError when the root is not the expected root.
 * The caller must load the SDK WASM before it calls this function.
 */
export function loadRegisterDomainScript(): NoteScript {
  const script = NoteScript.deserialize(base64ToBytes(REGISTER_DOMAIN_SCRIPT_B64));
  const actualRoot = script.root().toHex().toLowerCase();
  const expectedRoot = REGISTER_DOMAIN_SCRIPT_ROOT_HEX.toLowerCase();
  if (actualRoot !== expectedRoot) {
    script.free();
    throw new MidenNameScriptMismatchError(expectedRoot, actualRoot);
  }
  return script;
}
