import { TransactionResult } from '@miden-sdk/miden-sdk';
import BigNumber from 'bignumber.js';

import { ITransaction } from '../db/types';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { compareAccountIds } from './utils';

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

  const inputFaucetIds: string[] = [];
  const outputFaucetIds: string[] = [];
  let faucetId: string | undefined;
  let inputAmount = BigInt(0);
  let outputAmount = BigInt(0);
  inputNotes.forEach(inputNote => {
    const assets = inputNote.note().assets().fungibleAssets();
    inputAmount = assets.reduce((acc, asset) => acc + BigInt(asset.amount()), BigInt(0));
    const faucetIds = [...new Set(assets.map(asset => getBech32AddressFromAccountId(asset.faucetId())))];
    inputFaucetIds.push(...faucetIds);
  });
  outputNotes.forEach(outputNote => {
    const assets = outputNote.assets()!.fungibleAssets();
    outputAmount = assets.reduce((acc, asset) => acc + BigInt(asset.amount()), BigInt(0));
    const faucetIds = [...new Set(assets.map(asset => getBech32AddressFromAccountId(asset.faucetId())))];
    outputFaucetIds.push(...faucetIds);
  });
  const transactionAmount = inputAmount - outputAmount;
  const absoluteTransactionAmount = transactionAmount > 0n ? transactionAmount : -transactionAmount;

  if (inputFaucetIds.length === 1 && outputFaucetIds.length === 0) {
    type = 'consume';
    const sender = getBech32AddressFromAccountId(inputNotes[0].note().metadata().sender());
    const isReclaimed = compareAccountIds(sender, transaction.accountId);
    displayMessage = isReclaimed ? 'Reclaimed' : 'Received';
    if (!isReclaimed) {
      secondaryAccountId = sender;
    }

    faucetId = inputFaucetIds[0];
    displayIcon = 'RECEIVE';
  } else if (outputFaucetIds.length === 1 && inputFaucetIds.length === 0) {
    type = 'send';
    displayMessage = 'Sent';
    displayIcon = 'SEND';
    faucetId = outputFaucetIds[0];
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
