import BigNumber from 'bignumber.js';

import { ITransaction } from '../db/types';
import { isPositiveNumber, toTokenId, tryParseTokenTransfers, interpretTransactionResult } from './helpers';

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

  describe('interpretTransactionResult', () => {
    const createMockNote = (faucetId: string, amount: bigint, senderId?: string) => ({
      note: () => ({
        assets: () => ({
          fungibleAssets: () => [
            {
              faucetId: () => faucetId,
              amount: () => amount
            }
          ]
        }),
        metadata: () => ({
          sender: () => senderId || 'default-sender'
        })
      }),
      id: () => ({ toString: () => `note-${faucetId}` }),
      assets: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => faucetId,
            amount: () => amount
          }
        ]
      })
    });

    const createMockResult = (inputNotes: any[], outputNotes: any[]) => ({
      executedTransaction: () => ({
        inputNotes: () => ({ notes: () => inputNotes }),
        outputNotes: () => ({ notes: () => outputNotes }),
        id: () => ({ toHex: () => 'tx-hex-id' })
      }),
      serialize: () => new Uint8Array([])
    });

    it('interprets consume transaction (receive)', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account',
        secondaryAccountId: undefined
      };

      const inputNote = createMockNote('faucet-1', BigInt(1000), 'other-sender');
      const result = createMockResult([inputNote], []);

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.type).toBe('consume');
      expect(updated.displayMessage).toBe('Received');
      expect(updated.displayIcon).toBe('RECEIVE');
      expect(updated.transactionId).toBe('tx-hex-id');
    });

    it('interprets consume transaction (reclaim)', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'bech32_my-sender',
        secondaryAccountId: undefined
      };

      const inputNote = createMockNote('faucet-1', BigInt(1000), 'my-sender');
      const result = createMockResult([inputNote], []);

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.type).toBe('consume');
      expect(updated.displayMessage).toBe('Reclaimed');
    });

    it('interprets send transaction', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account',
        secondaryAccountId: undefined
      };

      const outputNote = createMockNote('faucet-1', BigInt(500));
      const result = createMockResult([], [outputNote]);

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.type).toBe('send');
      expect(updated.displayMessage).toBe('Sent');
      expect(updated.displayIcon).toBe('SEND');
    });

    it('interprets generic execute transaction', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account'
      };

      // Multiple input and output faucets - treated as generic execute
      const inputNote = createMockNote('faucet-1', BigInt(1000));
      const outputNote = createMockNote('faucet-2', BigInt(500));
      const result = createMockResult([inputNote], [outputNote]);

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.displayMessage).toBe('Executed');
    });

    it('calculates transaction amount', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        accountId: 'my-account'
      };

      const inputNote = createMockNote('faucet-1', BigInt(1000), 'other-sender');
      const result = createMockResult([inputNote], []);

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.amount).toBe(BigInt(1000));
    });
  });
});
