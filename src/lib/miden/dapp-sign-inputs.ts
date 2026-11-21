import { Felt, FeltArray, Rpo256, SigningInputs, SigningInputsType } from '@miden-sdk/miden-sdk/lazy';
import type { SignKind } from '@miden-sdk/miden-wallet-adapter-base';

import { b64ToU8 } from 'lib/shared/helpers';

import {
  domainTagPreimage,
  GUARDIAN_LOOKUP_DOMAIN_STRING,
  isProtocolMessageLayout,
  MAX_SIGN_PAYLOAD_CHARS,
  MAX_SIGN_PREIMAGE_ELEMENTS,
  type ProtocolTags
} from './dapp-sign-rule';
import { rethrowTrapOrKill } from './sdk/sdk-error-code';
import { readWasmHandle } from './sdk/wasm-handle';

let cachedProtocolTags: ProtocolTags | undefined;

/**
 * The domain tags of the protocol messages, derived once on first use and then cached. The Guardian lookup tag is
 * `Rpo256.hashElements` of the packed domain string, as `domainTagWord` in the multisig client computes it.
 * `dapp-sign-inputs.real-sdk.test.ts` pins the derived tag against the client's `lookupAuthDigest`.
 */
export function protocolTags(): ProtocolTags {
  if (cachedProtocolTags !== undefined) return cachedProtocolTags;
  // The browser binding takes each element into the array, and the array into the hash.
  const preimage = new FeltArray(domainTagPreimage(GUARDIAN_LOOKUP_DOMAIN_STRING).map(value => new Felt(value)));
  const tag = Rpo256.hashElements(preimage);
  const guardianLookup = readWasmHandle(tag, word =>
    word.toFelts().map(felt => readWasmHandle(felt, element => element.asInt()))
  );
  cachedProtocolTags = { guardianLookup };
  return cachedProtocolTags;
}

/**
 * The preimage of a dApp signature request, when the wallet may sign the request (`DAPP_SIGN_RULE`), which only a
 * Guardian account is held to. Returns `undefined` when the wallet refuses the request: the kind is not
 * `signingInputs`, the payload is longer than `MAX_SIGN_PAYLOAD_CHARS` or does not deserialize, the variant is not
 * `Arbitrary`, the preimage is longer than `MAX_SIGN_PREIMAGE_ELEMENTS`, or it has a protocol message layout
 * (`isProtocolMessageLayout`). If the wallet cannot derive the protocol tags, it refuses the request.
 *
 * `payload` is the base64 of the serialized `SigningInputs`. Call this only after the SDK's WASM module is loaded, and
 * inside `withWasmClientLock` where the caller can: a WASM trap is thrown, not read as a refusal.
 */
export function signableArbitraryElements(kind: SignKind, payload: string): bigint[] | undefined {
  if (kind !== 'signingInputs' || payload.length > MAX_SIGN_PAYLOAD_CHARS) return undefined;
  let tags: ProtocolTags;
  let inputs: SigningInputs;
  try {
    tags = protocolTags();
    inputs = SigningInputs.deserialize(b64ToU8(payload));
  } catch (error) {
    // A trap is no verdict on the request: the caller's WASM lock retires the poisoned client only when it sees it.
    rethrowTrapOrKill(error);
    return undefined;
  }
  return readWasmHandle(inputs, parsed => {
    if (parsed.variantType !== SigningInputsType.Arbitrary) return undefined;
    const elements = readElements(parsed);
    if (elements === undefined) return undefined;
    return isProtocolMessageLayout(elements, tags) ? undefined : elements;
  });
}

// `readWasmHandle` frees each handle but never after a trap: a throwing free on an aborted instance could replace the
// trap that the caller's WASM lock has to see to retire the client.
function readElements(inputs: SigningInputs): bigint[] | undefined {
  return readWasmHandle(inputs.toElements(), array => {
    const count = array.length();
    if (count > MAX_SIGN_PREIMAGE_ELEMENTS) return undefined;
    const elements: bigint[] = [];
    for (let index = 0; index < count; index += 1) {
      elements.push(readWasmHandle(array.get(index), felt => felt.asInt()));
    }
    return elements;
  });
}
