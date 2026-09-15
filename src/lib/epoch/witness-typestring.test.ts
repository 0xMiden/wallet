import {
  EVM_TO_MIDEN_EXTRA_TYPESTRING,
  MIDEN_TO_EVM_EXTRA_TYPESTRING,
  validateWitnessTypeString
} from '@epoch-protocol/epoch-intents-sdk';

import {
  buildEpochTaskDataParams,
  buildEVMToMidenTaskDataParams,
  evmToMidenMinTokenOut,
  normalizeMidenIdToHex
} from './bridge';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { buildEarnTaskDataParams, EARN_UNDERLYING } from './earn';
import type { EVMToMidenIntentParams } from './types';

jest.mock('lib/miden/activity', () => ({ updateEarnDepositStatus: jest.fn() }));
jest.mock('./earn-note', () => ({ createEarnP2IDENote: jest.fn() }));
jest.mock('./sdk', () => ({ getEpochReadOnlySdk: jest.fn() }));

const midenSourceAccount = '0x0123456789abcdef0123456789abcd';
const midenFaucetId = '0x123456789abcdef0123456789abcde';
const evmRecipient = '0x0000000000000000000000000000000000000001' as const;

describe('Miden witness typestrings', () => {
  it('keeps the canonical Miden suffix last for Earn positions', () => {
    const task = buildEarnTaskDataParams({
      midenSourceAccount,
      midenFaucetId,
      depositAmount: '1000000',
      evmRecipient,
      midenReclaimHeight: 1234
    });

    expect(task.extraDataTypestring.endsWith(MIDEN_TO_EVM_EXTRA_TYPESTRING)).toBe(true);
    expect(validateWitnessTypeString(task.extraDataTypestring, task.extraData)).toEqual({ valid: true });
  });

  it('keeps the canonical Miden suffix last for bridge sends', () => {
    const task = buildEpochTaskDataParams({
      midenAccountId: midenSourceAccount,
      midenFaucetId,
      midenAmount: '1000000',
      midenReclaimHeight: 1234,
      evmRecipient,
      destinationChainId: 11155111,
      outputTokenAddress: EARN_UNDERLYING,
      minTokenOut: '0'
    });

    expect(task.extraDataTypestring?.endsWith(MIDEN_TO_EVM_EXTRA_TYPESTRING)).toBe(true);
    expect(validateWitnessTypeString(task.extraDataTypestring!, task.extraData)).toEqual({ valid: true });
  });
});

describe('EVM to Miden reverse quote', () => {
  const base = {
    sourceChainId: 11155111,
    destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
    evmSourceAddress: evmRecipient,
    evmTokenAddress: '0x0000000000000000000000000000000000000002',
    midenRecipientId: midenSourceAccount,
    midenFaucetId
  };

  it('asks the allocator for the EVM spend: a zero tokenIn, the Miden output and the canonical witness', () => {
    const task = buildEVMToMidenTaskDataParams({ ...base, minTokenOut: '1500000' });

    expect(task.intentData.tokenInAmount).toBe('0');
    expect(task.intentData.minTokenOut).toBe('1500000');
    expect(task.extraDataTypestring).toBe(EVM_TO_MIDEN_EXTRA_TYPESTRING);
    expect(task.extraData).toEqual({
      midenRecipientAccount: normalizeMidenIdToHex(midenSourceAccount),
      midenFaucetId: normalizeMidenIdToHex(midenFaucetId)
    });
    expect(validateWitnessTypeString(task.extraDataTypestring, task.extraData)).toEqual({ valid: true });
  });

  it('has no fixed EVM input to quote from', () => {
    const params: EVMToMidenIntentParams = {
      ...base,
      minTokenOut: '1500000',
      // @ts-expect-error the reverse quote derives the EVM spend, so there is no EVM input amount
      evmAmount: '2'
    };

    expect(buildEVMToMidenTaskDataParams(params).intentData.tokenInAmount).toBe('0');
  });

  it.each([
    ['1.5', '1500000'],
    ['0.0000001', undefined],
    ['0', undefined],
    ['-1', undefined],
    ['abc', undefined]
  ])('turns the typed amount %s into the Miden base units a quote asks for', (amount, units) => {
    expect(evmToMidenMinTokenOut(amount, 6)).toBe(units);
  });

  it('refuses a quote without a Miden output', () => {
    expect(() => buildEVMToMidenTaskDataParams({ ...base, minTokenOut: '0' })).toThrow('minTokenOut');
  });
});
