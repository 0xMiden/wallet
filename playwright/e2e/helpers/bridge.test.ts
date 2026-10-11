/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

import { bridgedSendRowOf, enText, parseBridgeReceiveState } from './bridge';

const EN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/_locales/en/en.json'), 'utf8'));

describe('enText', () => {
  it('returns the English copy verbatim when it has no placeholder', () => {
    expect(enText('usdcxWithdrawalNotice')).toBe(EN.usdcxWithdrawalNotice);
  });

  it('replaces every placeholder it is given', () => {
    expect(enText('guardianHistoryPartial', { count: '3' })).toBe(
      String(EN.guardianHistoryPartial).split('$count$').join('3')
    );
  });

  it('throws on a key the English bundle does not have', () => {
    expect(() => enText('noSuchKeyAnywhere')).toThrow('has no "noSuchKeyAnywhere"');
  });

  it('throws when a placeholder is left unreplaced', () => {
    expect(() => enText('guardianHistoryPartial')).toThrow('still holds $count$');
  });

  it('throws on a value the copy has no placeholder for, so stale copy cannot pass', () => {
    expect(() => enText('usdcxWithdrawalNotice', { symbol: 'USDCX' })).toThrow('has no $symbol$');
  });
});

describe('bridgedSendRowOf', () => {
  const projected = {
    id: '5a249251-3b28-4100-b291-fc5396b61271',
    type: 'bridged-send',
    status: 2,
    stage: 'complete',
    stageTimestamps: { 'creating-proposal': 1791663049003, 'signing-proposal': 1791663049686 },
    displayMessage: 'USDCx burn submitted',
    transactionId: '0xdaca157101a0be401b08c153bcaa530b3644bd6bd68a613d18b203462e1e42b5',
    outputNoteIds: ['0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b'],
    requestBytes: [1, 2],
    feeAmount: '133',
    feeFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
    completedAt: 1791663053,
    resultBytes: 'AAEC',
    submitEvidence: [{ attemptId: '5826a0ee', source: 'pin' }],
    extraInputs: {
      provider: 'usdcx',
      destinationAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
      destinationNetwork: 5042002,
      sourceFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      claimStatus: 'not-applicable',
      usdcxBurn: {
        noteId: '0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b',
        destinationDomain: 26,
        phase: 'confirmed',
        attemptCount: 0,
        destinationBalanceBefore: { balance: '0', blockNumber: '66531904' },
        destinationBalanceConfirmed: { balance: '9983600', blockNumber: '66531958' }
      }
    }
  };

  it('types a USDCx burn row field by field, including both destination balances', () => {
    expect(bridgedSendRowOf(projected)).toEqual({
      id: '5a249251-3b28-4100-b291-fc5396b61271',
      status: 2,
      stage: 'complete',
      stageTimestamps: { 'creating-proposal': 1791663049003, 'signing-proposal': 1791663049686 },
      displayMessage: 'USDCx burn submitted',
      transactionId: '0xdaca157101a0be401b08c153bcaa530b3644bd6bd68a613d18b203462e1e42b5',
      outputNoteIds: ['0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b'],
      requestBytes: [1, 2],
      feeAmount: '133',
      feeFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      completedAt: 1791663053,
      resultBytes: 'AAEC',
      submitEvidence: [{ attemptId: '5826a0ee', source: 'pin' }],
      extraInputs: {
        provider: 'usdcx',
        destinationAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
        destinationNetwork: 5042002,
        claimStatus: 'not-applicable',
        usdcxBurn: {
          noteId: '0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b',
          destinationDomain: 26,
          phase: 'confirmed',
          attemptCount: 0,
          destinationBalanceBefore: { balance: '0', blockNumber: '66531904' },
          destinationBalanceConfirmed: { balance: '9983600', blockNumber: '66531958' }
        }
      }
    });
  });

  it('drops a usdcxBurn that lacks its note id, domain or phase rather than half-typing it', () => {
    const row = bridgedSendRowOf({ ...projected, extraInputs: { provider: 'usdcx', usdcxBurn: { noteId: '0x96' } } });
    expect(row.extraInputs?.usdcxBurn).toBeUndefined();
    expect(row.extraInputs?.provider).toBe('usdcx');
  });

  it('reads a row with no status as -1, as the old reader did', () => {
    expect(bridgedSendRowOf({ id: 'r1' }).status).toBe(-1);
    expect(bridgedSendRowOf({ id: 'r1' }).extraInputs).toBeUndefined();
  });
});

describe('parseBridgeReceiveState', () => {
  it('keeps every field the hook returns, typed', () => {
    expect(
      parseBridgeReceiveState({
        found: true,
        phase: 'failed',
        displayMessage: 'Bridged from EVM',
        status: 3,
        amount: '2000000000',
        faucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
        evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
        error: 'Circle attested this deposit to a different Miden account.',
        midenNoteId: '0xbf20',
        sourceChainId: 5042002,
        usdcxRemoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
        readyAt: 1791663100
      })
    ).toEqual({
      found: true,
      phase: 'failed',
      displayMessage: 'Bridged from EVM',
      status: 3,
      amount: '2000000000',
      faucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
      error: 'Circle attested this deposit to a different Miden account.',
      midenNoteId: '0xbf20',
      sourceChainId: 5042002,
      usdcxRemoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
      readyAt: 1791663100
    });
  });

  it('reads a missing row as not found', () => {
    expect(parseBridgeReceiveState({ found: false })).toEqual({ found: false });
  });

  it('refuses a phase the wallet does not have', () => {
    expect(() => parseBridgeReceiveState({ found: true, phase: 'settled' })).toThrow('unknown phase "settled"');
  });

  it('refuses an answer that is not a state object', () => {
    expect(() => parseBridgeReceiveState(null)).toThrow('not a state object');
  });
});
