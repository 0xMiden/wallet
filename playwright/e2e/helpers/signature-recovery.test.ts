/**
 * @jest-environment node
 */
import { recoverEcdsaPublicKey } from './signature-recovery';
import vector from './signature-recovery.vector.json';

describe('recoverEcdsaPublicKey', () => {
  it('recovers the key the page signed a word with', () => {
    expect(recoverEcdsaPublicKey(vector.word.signatureB64, vector.word.messageB64)).toBe(vector.word.publicKeyB64);
  });

  it('recovers the key the page signed SigningInputs with, over their commitment', () => {
    expect(recoverEcdsaPublicKey(vector.signingInputs.signatureB64, vector.signingInputs.messageB64)).toBe(
      vector.signingInputs.publicKeyB64
    );
  });

  it('recovers a different key for a different message', () => {
    const other = Buffer.alloc(32, 7).toString('base64');
    expect(recoverEcdsaPublicKey(vector.word.signatureB64, other)).not.toBe(vector.word.publicKeyB64);
  });

  it('refuses a signature that is not ECDSA', () => {
    const falcon = Buffer.from([0x02, ...Buffer.from(vector.word.signatureB64, 'base64').subarray(1)]).toString(
      'base64'
    );
    expect(() => recoverEcdsaPublicKey(falcon, vector.word.messageB64)).toThrow('not an ECDSA signature');
  });
});
