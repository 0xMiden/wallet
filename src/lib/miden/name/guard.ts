/**
 * Checks that must pass before the wallet submits a Miden Name register note.
 *
 * These checks use RPC only. They do not take the WASM client lock.
 */

import type { IPublishNameRecordExtraInputs, IRegisterNameExtraInputs, ITransaction } from 'lib/miden/db/types';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { getMidenNameConfig } from './config';
import { validateMidenLabel } from './encoding';
import {
  MidenNameInvalidLabelError,
  MidenNamePriceChangedError,
  MidenNameRegistrationExpiredError,
  MidenNameRegistrationInputError,
  MidenNameScriptNotAllowedError,
  MidenNameTakenError,
  MidenNameUnsupportedNetworkError
} from './errors';
import { REGISTRY_SCRIPT_ROOT_HEX } from './note-script-roots';
import { fetchMidenNameQuote, fetchRegistryScriptAllowed, getChainTip, type MidenNameQuote } from './reads';
import { loadRegisterDomainScript, loadRegistryNoteScript } from './script';

/**
 * The wallet does not submit a register note when the chain tip is this near
 * the reclaim height. The registry must have time to consume the note before
 * the payer can reclaim it.
 */
export const MIDEN_NAME_RECLAIM_SAFETY_BLOCKS = 20;

/**
 * Read a fresh quote and make sure that a register note for `label` can
 * succeed: the name is free, the registry allows the register script, and
 * (when given) the price is `expectedPrice`. Also make sure that the bundled
 * script has the expected root. Returns the fresh quote.
 */
export async function assertRegistrationPreconditions(label: string, expectedPrice?: bigint): Promise<MidenNameQuote> {
  const labelError = validateMidenLabel(label);
  if (labelError) throw new MidenNameInvalidLabelError(label, labelError);

  const quote = await fetchMidenNameQuote(label, { fresh: true });
  if (!quote.available) throw new MidenNameTakenError(label);
  if (!quote.scriptAllowed) throw new MidenNameScriptNotAllowedError();
  if (expectedPrice !== undefined && quote.priceBaseUnits !== expectedPrice) {
    throw new MidenNamePriceChangedError(expectedPrice, quote.priceBaseUnits);
  }
  // The quote loaded the SDK WASM. The script is a plain SDK object, not a
  // client call, so no lock is necessary. Free it: this is a check only.
  (await loadRegisterDomainScript()).free();
  return quote;
}

interface LiveRegistrationInputs {
  label: string;
  network: string;
  priceBaseUnits: bigint;
  reclaimHeight: number;
}

function readRegistrationInputs(tx: ITransaction): LiveRegistrationInputs {
  const inputs: Partial<IRegisterNameExtraInputs> | undefined = tx.extraInputs;
  if (!inputs) throw new MidenNameRegistrationInputError('no extraInputs');
  const { label, network, priceBaseUnits, reclaimHeight } = inputs;
  if (typeof label !== 'string') throw new MidenNameRegistrationInputError('no label');
  if (typeof network !== 'string') throw new MidenNameRegistrationInputError('no network');
  if (typeof priceBaseUnits !== 'string' || !/^\d+$/.test(priceBaseUnits)) {
    throw new MidenNameRegistrationInputError('no price');
  }
  if (typeof reclaimHeight !== 'number' || !Number.isSafeInteger(reclaimHeight)) {
    throw new MidenNameRegistrationInputError('no reclaim height');
  }
  return { label, network, priceBaseUnits: BigInt(priceBaseUnits), reclaimHeight };
}

/**
 * The pipeline calls this immediately before it submits a `register-name` row
 * (standard leaf and guardian proposal). A throw is terminal: the pipeline
 * marks the row Failed and does not requeue it.
 *
 * Refuses when the row is for an other network, the name is taken, the
 * registry does not allow the script, the price changed, or the chain tip is
 * at or after `reclaimHeight - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS`.
 */
export async function assertMidenNameRegistrationLive(tx: ITransaction): Promise<void> {
  const inputs = readRegistrationInputs(tx);
  const config = getMidenNameConfig();
  if (!config || config.network !== inputs.network) {
    throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  }
  await assertRegistrationPreconditions(inputs.label, inputs.priceBaseUnits);
  const tip = await getChainTip();
  if (tip >= inputs.reclaimHeight - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS) {
    throw new MidenNameRegistrationExpiredError(tip, inputs.reclaimHeight);
  }
}

interface LivePublishInputs {
  label: string;
  network: string;
  reclaimHeight: number;
}

function readPublishInputs(tx: ITransaction): LivePublishInputs {
  const inputs: Partial<IPublishNameRecordExtraInputs> | undefined = tx.extraInputs;
  if (!inputs) throw new MidenNameRegistrationInputError('no extraInputs');
  const { label, network, reclaimHeight } = inputs;
  if (typeof label !== 'string') throw new MidenNameRegistrationInputError('no label');
  if (typeof network !== 'string') throw new MidenNameRegistrationInputError('no network');
  if (typeof reclaimHeight !== 'number' || !Number.isSafeInteger(reclaimHeight)) {
    throw new MidenNameRegistrationInputError('no reclaim height');
  }
  return { label, network, reclaimHeight };
}

/**
 * The pipeline calls this immediately before it submits a `publish-name-record`
 * row (standard leaf and guardian proposal). A throw is terminal: the pipeline
 * marks the row Failed and does not requeue it.
 *
 * Refuses when the row is for an other network, the label is not valid, the
 * registry does not allow the registry script, the vendored script has an
 * other root, or the chain tip is at or after
 * `reclaimHeight - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS`. Custody of the NFA is
 * not checked here: the transaction execution fails without it.
 */
export async function assertMidenNamePublishLive(tx: ITransaction): Promise<void> {
  const inputs = readPublishInputs(tx);
  const config = getMidenNameConfig();
  if (!config || config.network !== inputs.network) {
    throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  }
  const labelError = validateMidenLabel(inputs.label);
  if (labelError) throw new MidenNameInvalidLabelError(inputs.label, labelError);
  if (!(await fetchRegistryScriptAllowed(REGISTRY_SCRIPT_ROOT_HEX))) throw new MidenNameScriptNotAllowedError();
  // The read loaded the SDK WASM. The script is a plain SDK object: no lock. Free it.
  (await loadRegistryNoteScript()).free();
  const tip = await getChainTip();
  if (tip >= inputs.reclaimHeight - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS) {
    throw new MidenNameRegistrationExpiredError(tip, inputs.reclaimHeight);
  }
}
