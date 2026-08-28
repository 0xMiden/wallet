import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';
import { isFeeNote } from './fee';
import BigNumber from 'bignumber.js';

import { compareAccountIds } from './utils';
import { ITransaction } from '../db/types';
import { getBech32AddressFromAccountId } from '../sdk/helpers';

export function tryParseTokenTransfers(
  parameters: any,
  destination: string,
  onTransfer: (tokenId: string, from: string, to: string, amount: string) => void
) {
  // FA1.2
  try {
    formatFa12(parameters, destination, onTransfer);
  } catch {}

  // FA2
  try {
    formatFa2(parameters, destination, onTransfer);
  } catch {}
}

export function isPositiveNumber(val: BigNumber.Value) {
  return new BigNumber(val).isGreaterThan(0);
}

export function toTokenId(contractAddress: string, tokenId: string | number = 0) {
  return `${contractAddress}_${tokenId}`;
}

const formatFa12 = (
  parameters: any,
  destination: string,
  onTransfer: (tokenId: string, from: string, to: string, amount: string) => void
) => {
  const { entrypoint, value } = parameters;
  if (entrypoint === 'transfer') {
    let from, to, amount: string | undefined;

    const { args: x } = value;
    if (typeof x[0].string === 'string') {
      from = x[0].string;
    }
    const { args: y } = x[1];
    if (typeof y[0].string === 'string') {
      to = y[0].string;
    }
    if (typeof y[1].int === 'string') {
      amount = y[1].int;
    }

    if (from && to && amount) {
      onTransfer(toTokenId(destination), from, to, amount);
    }
  }
};

const formatFa2 = (
  parameters: any,
  destination: string,
  onTransfer: (tokenId: string, from: string, to: string, amount: string) => void
) => {
  const { entrypoint, value } = parameters;
  if (entrypoint !== 'transfer') return;
  for (const { args: x } of value) {
    let from: string | undefined;

    from = checkIfVarString(x);
    for (const { args: y } of x[1]) {
      let to, tokenId, amount: string | undefined;

      to = checkIfVarString(y);
      tokenId = checkDestination(y[1].args[0], destination);
      amount = checkIfIntString(y[1].args[1]);

      if (from && to && tokenId && amount) {
        onTransfer(tokenId, from, to, amount);
      }
    }
  }
};

const checkIfVarString = (x: any) => (typeof x[0].string === 'string' ? x[0].string : undefined);

const checkIfIntString = (x: any) => (typeof x.int === 'string' ? x.int : undefined);

const checkDestination = (x: any, destination: string) =>
  typeof x.int === 'string' ? toTokenId(destination, x.int) : undefined;

export const interpretTransactionResult = <K extends keyof ITransaction>(
  transaction: ITransaction,
  result: TransactionResult
): Pick<ITransaction, K> => {
  let type = transaction.type;
  let displayMessage = transaction.displayMessage;
  let displayIcon = transaction.displayIcon;
  let secondaryAccountId = transaction.secondaryAccountId;
  const inputNotes = result.executedTransaction().inputNotes().notes();
  const outputNotes = result.executedTransaction().outputNotes().notes();

  // Both totals ACCUMULATE across notes, and both faucet sets are deduped across
  // the whole loop (not per note). A custom (`execute`) transaction can consume or
  // emit several notes: assigning per note left only the LAST note's total behind,
  // so a two-note consume recorded half the value that actually moved, and pushing
  // one faucet id per note made a two-note single-faucet transaction look like two
  // distinct faucets — failing both single-faucet branches below and degrading the
  // row to the generic 'Executed' label.
  const inputFaucetIds = new Set<string>();
  const outputFaucetIds = new Set<string>();
  let faucetId: string | undefined;
  let inputAmount = BigInt(0);
  let outputAmount = BigInt(0);
  inputNotes.forEach(inputNote => {
    const assets = inputNote.note().assets().fungibleAssets();
    inputAmount += assets.reduce((acc, asset) => acc + BigInt(asset.amount()), BigInt(0));
    assets.forEach(asset => inputFaucetIds.add(getBech32AddressFromAccountId(asset.faucetId())));
  });
  outputNotes.forEach(outputNote => {
    // The kernel's fee note is an output note too, but it is not value the user
    // sent: folding it in inflates the amount and adds the native faucet to the
    // set, which can flip a single-faucet send into the generic 'Executed' label.
    if (isFeeNote(outputNote)) return;
    const assets = outputNote.assets()!.fungibleAssets();
    outputAmount += assets.reduce((acc, asset) => acc + BigInt(asset.amount()), BigInt(0));
    assets.forEach(asset => outputFaucetIds.add(getBech32AddressFromAccountId(asset.faucetId())));
  });
  const transactionAmount = inputAmount - outputAmount;
  const absoluteTransactionAmount = transactionAmount > 0n ? transactionAmount : -transactionAmount;

  if (inputFaucetIds.size === 1 && outputFaucetIds.size === 0) {
    type = 'consume';
    const sender = getBech32AddressFromAccountId(inputNotes[0]!.note().metadata().sender());
    const isReclaimed = compareAccountIds(sender, transaction.accountId);
    displayMessage = isReclaimed ? 'Reclaimed' : 'Received';
    if (!isReclaimed) {
      secondaryAccountId = sender;
    }

    faucetId = [...inputFaucetIds][0];
    displayIcon = 'RECEIVE';
  } else if (outputFaucetIds.size === 1 && inputFaucetIds.size === 0) {
    type = 'send';
    displayMessage = 'Sent';
    displayIcon = 'SEND';
    faucetId = [...outputFaucetIds][0];
  } else {
    displayMessage = 'Executed';
  }

  const updates = {
    type,
    displayMessage,
    displayIcon,
    secondaryAccountId,
    transactionId: result.executedTransaction().id().toHex(),
    inputNoteIds: inputNotes.map(note => note.id().toString()),
    amount: absoluteTransactionAmount !== BigInt(0) ? absoluteTransactionAmount : undefined,
    outputNoteIds: outputNotes.map(note => note.id().toString()),
    faucetId,
    resultBytes: result.serialize()
  };

  return Object.assign(transaction, updates);
};
