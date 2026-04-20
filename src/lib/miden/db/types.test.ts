import { ConsumableNote, NoteTypeEnum } from '../types';
import { ConsumeTransaction, formatTransactionStatus, ITransactionStatus, SendTransaction, Transaction } from './types';

jest.useFakeTimers().setSystemTime(new Date('2024-01-01').getTime());

describe('transaction models', () => {
  it('initializes Transaction defaults', () => {
    const tx = new Transaction('acc', new Uint8Array([1, 2]), ['n1'], true, 'recip');
    expect(tx.type).toBe('execute');
    expect(tx.status).toBe(ITransactionStatus.Queued);
    expect(tx.displayMessage).toBe('Executing');
    expect(tx.delegateTransaction).toBe(true);
    expect(tx.secondaryAccountId).toBe('recip');
  });

  it('initializes SendTransaction defaults', () => {
    const tx = new SendTransaction('acc', BigInt(10), 'recip', 'faucet', NoteTypeEnum.Public, 5, true);
    expect(tx.type).toBe('send');
    expect(tx.status).toBe(ITransactionStatus.Queued);
    expect(tx.displayIcon).toBe('SEND');
    expect(tx.extraInputs.recallBlocks).toBe(5);
    expect(tx.delegateTransaction).toBe(true);
  });

  it('initializes ConsumeTransaction defaults', () => {
    const note: ConsumableNote = {
      id: 'note1',
      faucetId: 'faucet',
      amount: '1',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: NoteTypeEnum.Private
    };
    const tx = new ConsumeTransaction('acc', note, true);
    expect(tx.type).toBe('consume');
    expect(tx.status).toBe(ITransactionStatus.Queued);
    expect(tx.displayIcon).toBe('RECEIVE');
    expect(tx.delegateTransaction).toBe(true);
    expect(tx.completedAt).toBeUndefined();
  });

  it('formats transaction status', () => {
    expect(formatTransactionStatus(ITransactionStatus.GeneratingTransaction)).toBe('Generating Transaction');
  });

  it('formats all transaction statuses', () => {
    expect(formatTransactionStatus(ITransactionStatus.Queued)).toBe('Queued');
    expect(formatTransactionStatus(ITransactionStatus.Completed)).toBe('Completed');
    expect(formatTransactionStatus(ITransactionStatus.Failed)).toBe('Failed');
  });

  it('handles ConsumeTransaction with empty amount string', () => {
    const note: ConsumableNote = {
      id: 'note2',
      faucetId: 'faucet',
      amount: '',
      senderAddress: 'sender',
      type: NoteTypeEnum.Private,
      isBeingClaimed: false
    };
    const tx = new ConsumeTransaction('acc', note);
    expect(tx.amount).toBeUndefined();
    expect(tx.delegateTransaction).toBeUndefined();
  });

  it('creates Transaction with minimal params', () => {
    const tx = new Transaction('acc', new Uint8Array([1]));
    expect(tx.inputNoteIds).toBeUndefined();
    expect(tx.delegateTransaction).toBeUndefined();
    expect(tx.secondaryAccountId).toBeUndefined();
  });

  it('creates SendTransaction with minimal params', () => {
    const tx = new SendTransaction('acc', BigInt(5), 'recip', 'faucet', NoteTypeEnum.Private);
    expect(tx.extraInputs.recallBlocks).toBeUndefined();
    expect(tx.delegateTransaction).toBeUndefined();
  });
});
