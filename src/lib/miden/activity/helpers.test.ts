import BigNumber from 'bignumber.js';

import { isPositiveNumber, toTokenId, tryParseTokenTransfers, interpretTransactionResult } from './helpers';
import { ITransaction } from '../db/types';

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

    it('accumulates the amount across MULTIPLE input notes instead of keeping only the last', () => {
      // A custom (`execute`) transaction can consume several notes. The per-note loop
      // used to ASSIGN `inputAmount`, so a two-note consume recorded only the last
      // note's total — half the value that actually moved — and pushed one faucet id
      // per note, which made a single-faucet transaction look like two faucets and
      // dropped the row to the generic 'Executed' label.
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account'
      };

      const result = createMockResult(
        [
          createMockNote('faucet-1', BigInt(50), 'other-sender'),
          createMockNote('faucet-1', BigInt(50), 'other-sender')
        ],
        []
      );

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.amount).toBe(BigInt(100));
      // Deduped across the whole loop, so the single-faucet classification still fires.
      expect(updated.type).toBe('consume');
      expect(updated.displayMessage).toBe('Received');
      expect(updated.faucetId).toBe('bech32_faucet-1');
    });

    it('accumulates the amount across MULTIPLE output notes instead of keeping only the last', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account'
      };

      const result = createMockResult(
        [],
        [createMockNote('faucet-1', BigInt(30)), createMockNote('faucet-1', BigInt(70))]
      );

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.amount).toBe(BigInt(100));
      expect(updated.type).toBe('send');
      expect(updated.displayMessage).toBe('Sent');
      expect(updated.faucetId).toBe('bech32_faucet-1');
    });

    it('still reports a genuinely multi-faucet consume as generic Executed', () => {
      // Dedupe must collapse REPEATS of one faucet, not distinct faucets — otherwise
      // a two-token transaction would be mislabelled as a single-token consume.
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        displayIcon: 'DEFAULT',
        accountId: 'my-account'
      };

      const result = createMockResult(
        [
          createMockNote('faucet-1', BigInt(50), 'other-sender'),
          createMockNote('faucet-2', BigInt(50), 'other-sender')
        ],
        []
      );

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.displayMessage).toBe('Executed');
      expect(updated.faucetId).toBeUndefined();
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

    it('sets amount to undefined when input and output amounts are equal (zero net)', () => {
      const transaction: Partial<ITransaction> = {
        type: 'execute',
        displayMessage: 'Executing',
        accountId: 'my-account'
      };

      const inputNote = createMockNote('faucet-1', BigInt(500), 'other-sender');
      const outputNote = createMockNote('faucet-1', BigInt(500));
      const result = createMockResult([inputNote], [outputNote]);

      const updated = interpretTransactionResult(transaction as ITransaction, result as any);

      expect(updated.amount).toBeUndefined();
    });
  });

  describe('tryParseTokenTransfers edge cases', () => {
    it('handles FA1.2 with non-string from field', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'transfer',
        value: {
          args: [
            { notAString: 123 },
            {
              args: [{ string: 'recipient' }, { int: '100' }]
            }
          ]
        }
      };
      tryParseTokenTransfers(parameters, 'contract', onTransfer);
      expect(onTransfer).not.toHaveBeenCalled();
    });

    it('handles FA2 with non-int tokenId', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'transfer',
        value: [
          {
            args: [
              { string: 'sender' },
              [
                {
                  args: [
                    { string: 'recipient' },
                    {
                      args: [{ notInt: 'invalid' }, { int: '2000' }]
                    }
                  ]
                }
              ]
            ]
          }
        ]
      };
      tryParseTokenTransfers(parameters, 'contract', onTransfer);
      expect(onTransfer).not.toHaveBeenCalled();
    });

    it('handles FA2 with non-string from field (checkIfVarString false branch)', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'transfer',
        value: [
          {
            args: [
              { notAString: 123 },
              [
                {
                  args: [
                    { string: 'recipient' },
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
      tryParseTokenTransfers(parameters, 'contract', onTransfer);
      expect(onTransfer).not.toHaveBeenCalled();
    });

    it('handles FA2 with non-int amount', () => {
      const onTransfer = jest.fn();
      const parameters = {
        entrypoint: 'transfer',
        value: [
          {
            args: [
              { string: 'sender' },
              [
                {
                  args: [
                    { string: 'recipient' },
                    {
                      args: [{ int: '5' }, { notInt: 'invalid' }]
                    }
                  ]
                }
              ]
            ]
          }
        ]
      };
      tryParseTokenTransfers(parameters, 'contract', onTransfer);
      expect(onTransfer).not.toHaveBeenCalled();
    });
  });
});
