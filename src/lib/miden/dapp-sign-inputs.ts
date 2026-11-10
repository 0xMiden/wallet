import { Felt, FeltArray, Rpo256, SigningInputs, SigningInputsType } from '@miden-sdk/miden-sdk/lazy';
import type { SignKind } from '@miden-sdk/miden-wallet-adapter-base';

import { b64ToU8 } from 'lib/shared/helpers';

import {
  domainTagPreimage,
  GUARDIAN_LOOKUP_DOMAIN_STRING,
  isProtocolMessageLayout,
  type ProtocolTags
} from './dapp-sign-rule';

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
  try {
    const guardianLookup = tag.toFelts().map(felt => {
      try {
        return felt.asInt();
      } finally {
        felt.free();
      }
    });
    cachedProtocolTags = { guardianLookup };
    return cachedProtocolTags;
  } finally {
    tag.free();
  }
}

/**
 * The preimage of a dApp signature request, when the hot key may sign the request (`DAPP_SIGN_RULE`). Returns
 * `undefined` when the wallet refuses the request: the kind is not `signingInputs`, the payload does not
 * deserialize, the variant is not `Arbitrary`, or the preimage has a protocol message layout
 * (`isProtocolMessageLayout`). If the wallet cannot derive the protocol tags, it refuses the request.
 *
 * `payload` is the base64 of the serialized `SigningInputs`. Call this only after the SDK's WASM module is loaded.
 */
export function signableArbitraryElements(kind: SignKind, payload: string): bigint[] | undefined {
  if (kind !== 'signingInputs') return undefined;
  let tags: ProtocolTags;
  let inputs: SigningInputs;
  try {
    tags = protocolTags();
    inputs = SigningInputs.deserialize(b64ToU8(payload));
  } catch {
    return undefined;
  }
  try {
    if (inputs.variantType !== SigningInputsType.Arbitrary) return undefined;
    const elements = readElements(inputs);
    return isProtocolMessageLayout(elements, tags) ? undefined : elements;
  } finally {
    inputs.free();
  }
}

function readElements(inputs: SigningInputs): bigint[] {
  const array = inputs.toElements();
  try {
    const elements: bigint[] = [];
    const count = array.length();
    for (let index = 0; index < count; index += 1) {
      const felt = array.get(index);
      try {
        elements.push(felt.asInt());
      } finally {
        felt.free();
      }
    }
    return elements;
  } finally {
    array.free();
  }
}
