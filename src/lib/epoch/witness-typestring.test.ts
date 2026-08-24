import { MIDEN_TO_EVM_EXTRA_TYPESTRING, validateWitnessTypeString } from '@epoch-protocol/epoch-intents-sdk';

import { buildEpochTaskDataParams } from './bridge';
import { buildEarnTaskDataParams, EARN_UNDERLYING } from './earn';

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
