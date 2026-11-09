import { SigningInputs, SigningInputsType } from '@miden-sdk/miden-sdk/lazy';
import type { SignKind } from '@miden-sdk/miden-wallet-adapter-base';

import { b64ToU8 } from 'lib/shared/helpers';

import { isProtocolMessageLayout } from './dapp-sign-rule';

/**
 * The preimage of a dApp signature request, when the hot key may sign the request (`DAPP_SIGN_RULE`). Returns
 * `undefined` when the wallet refuses the request: the kind is not `signingInputs`, the payload does not
 * deserialize, the variant is not `Arbitrary`, or the preimage has a protocol message layout
 * (`isProtocolMessageLayout`).
 *
 * `payload` is the base64 of the serialized `SigningInputs`. Call this only after the SDK's WASM module is loaded.
 */
export function signableArbitraryElements(kind: SignKind, payload: string): bigint[] | undefined {
  if (kind !== 'signingInputs') return undefined;
  let inputs: SigningInputs;
  try {
    inputs = SigningInputs.deserialize(b64ToU8(payload));
  } catch {
    return undefined;
  }
  try {
    if (inputs.variantType !== SigningInputsType.Arbitrary) return undefined;
    const elements = readElements(inputs);
    return isProtocolMessageLayout(elements) ? undefined : elements;
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
