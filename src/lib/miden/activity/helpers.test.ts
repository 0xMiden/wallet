import BigNumber from 'bignumber.js';

import { ITransaction } from '../db/types';
import { isPositiveNumber, toTokenId, tryParseTokenTransfers, interpretTransactionRecord } from './helpers';

// Mock the SDK helper
jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: any) => `bech32_${id}`)
}));

describe('activity/helpers', () => {
  describe('isPositiveNumber', () => {
    it('returns true for positive numbers', () => {
      expect(isPositiveNumber(1)).toBe(true);
      expect(isPositiveNumber(100)).toBe(true);
      expect(isPositiveNumber(0.001)).toBe(true);
      expect(isPositiveNumber('42')).toBe(true);
      expect(isPositiveNumber(new BigNumber(999))).toBe(true);
    });

    it('returns false for zero', () => {
      expect(isPositiveNumber(0)).toBe(false);
      expect(isPositiveNumber('0')).toBe(false);
      expect(isPositiveNumber(new BigNumber(0))).toBe(false);
    });

    it('returns false for negative numbers', () => {
      expect(isPositiveNumber(-1)).toBe(false);
      expect(isPositiveNumber(-100)).toBe(false);
      expect(isPositiveNumber('-42')).toBe(false);
      expect(isPositiveNumber(new BigNumber(-999))).toBe(false);
    });
  });

  describe('toTokenId', () => {
    it('returns contract_tokenId format', () => {
      expect(toTokenId('contract123')).toBe('contract123_0');
      expect(toTokenId('contract123', 0)).toBe('contract123_0');
      expect(toTokenId('contract123', 42)).toBe('contract123_42');
      expect(toTokenId('contract123', '99')).toBe('contract123_99');
    });

    it('handles various contract addresses', () => {
      expect(toTokenId('KT1abc', 1)).toBe('KT1abc_1');
      expect(toTokenId('0x123', 100)).toBe('0x123_100');
    });
  });

  describe('tryParseTokenTransfers', () => {
    it('parses FA1.2 transfer parameters', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'transfer',
        value: {
          args: [
            { string: 'sender-address' },
            {
              args: [{ string: 'recipient-address' }, { int: '1000' }]
            }
          ]
        }
      };

      tryParseTokenTransfers(parameters, 'contract-address', onTransfer);

      expect(onTransfer).toHaveBeenCalledWith('contract-address_0', 'sender-address', 'recipient-address', '1000');
    });

    it('parses FA2 transfer parameters', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'transfer',
        value: [
          {
            args: [
              { string: 'sender-address' },
              [
                {
                  args: [
                    { string: 'recipient-address' },
                    {
                      args: [{ int: '5' }, { int: '2000' }]
                    }
                  ]
                }
              ]
            ]
          }
        ]
      };

      tryParseTokenTransfers(parameters, 'contract-address', onTransfer);

      expect(onTransfer).toHaveBeenCalledWith('contract-address_5', 'sender-address', 'recipient-address', '2000');
    });

    it('does not call onTransfer for non-transfer entrypoints', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'approve',
        value: {}
      };

      tryParseTokenTransfers(parameters, 'contract-address', onTransfer);

      expect(onTransfer).not.toHaveBeenCalled();
    });

    it('handles malformed parameters gracefully', () => {
      const onTransfer = jest.fn();

      // Should not throw
      expect(() => {
        tryParseTokenTransfers(null, 'contract', onTransfer);
      }).not.toThrow();

      expect(() => {
        tryParseTokenTransfers({}, 'contract', onTransfer);
      }).not.toThrow();

      expect(() => {
        tryParseTokenTransfers({ entrypoint: 'transfer' }, 'contract', onTransfer);
      }).not.toThrow();

      expect(onTransfer).not.toHaveBeenCalled();
    });

    it('handles incomplete FA1.2 parameters', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'transfer',
        value: {
          args: [
            { string: 'sender-address' },
            {
              args: [{ notString: 'invalid' }, { int: '1000' }]
            }
          ]
        }
      };

      tryParseTokenTransfers(parameters, 'contract-address', onTransfer);

      // Should not call because 'to' is missing
      expect(onTransfer).not.toHaveBeenCalled();
    });
  });

  describe('interpretTransactionRecord', () => {
    const createMockOutputNote = (faucetId: string, amount: bigint) => ({
      id: () => ({ toString: () => `note-${faucetId}` }),
      assets: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => faucetId,
            amount: () => amount
          }
        ]
      }),
      metadata: () => ({
        noteType: () => 'public'
      }),
      intoFull: () => undefined
    });

    const createMockTxRecord = (outputNotes: any[]) => ({
      outputNotes: () => ({ notes: () => outputNotes }),
      id: () => ({ toHex: () => 'tx-hex-id' }),
      accountId: () => 'my-account',
      inputNoteNullifiers: () => []
    });

    it('interprets consume transaction (receive) based on inputNoteIds', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account',
        secondaryAccountId: undefined,
        inputNoteIds: ['note-1'],
        faucetId: 'bech32_faucet-1'
      };

      const txRecord = createMockTxRecord([]);

      const updated = interpretTransactionRecord(transaction as ITransaction, txRecord as any);

      expect(updated.type).toBe('consume');
      expect(updated.displayMessage).toBe('Received');
      expect(updated.displayIcon).toBe('RECEIVE');
      expect(updated.transactionId).toBe('tx-hex-id');
    });

    it('interprets send transaction based on output notes', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account',
        secondaryAccountId: undefined,
        inputNoteIds: []
      };

      const outputNote = createMockOutputNote('faucet-1', BigInt(500));
      const txRecord = createMockTxRecord([outputNote]);

      const updated = interpretTransactionRecord(transaction as ITransaction, txRecord as any);

      expect(updated.type).toBe('send');
      expect(updated.displayMessage).toBe('Sent');
      expect(updated.displayIcon).toBe('SEND');
    });

    it('interprets generic execute transaction', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account',
        inputNoteIds: ['note-1']
      };

      // Has both input and output notes - treated as generic execute
      const outputNote = createMockOutputNote('faucet-2', BigInt(500));
      const txRecord = createMockTxRecord([outputNote]);

      const updated = interpretTransactionRecord(transaction as ITransaction, txRecord as any);

      expect(updated.displayMessage).toBe('Executed');
    });

    it('extracts output note IDs', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        accountId: 'my-account',
        inputNoteIds: []
      };

      const outputNote = createMockOutputNote('faucet-1', BigInt(1000));
      const txRecord = createMockTxRecord([outputNote]);

      const updated = interpretTransactionRecord(transaction as ITransaction, txRecord as any);

      expect(updated.outputNoteIds).toEqual(['note-faucet-1']);
    });
  });
});
