import { buildSdkSignCallback, buildSignCallbackError, tagLockedSignReason } from './sign-callback';

describe('buildSdkSignCallback', () => {
  const publicKey = new Uint8Array([0x01, 0x02]);
  const signingInputs = new Uint8Array([0x10, 0x20]);

  it('hands the raw signer hex and returns its bytes', async () => {
    const raw = jest.fn(async () => new Uint8Array([0xab, 0xcd]));
    await expect(buildSdkSignCallback(raw)(publicKey, signingInputs)).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(raw).toHaveBeenCalledWith('0102', '1020');
  });

  it('classifies a locked vault, keeping the cause, so the transaction loop defers instead of failing (#313)', async () => {
    const underlying = new Error('Not initialized');
    const raw = jest.fn(async () => {
      throw underlying;
    });
    await expect(buildSdkSignCallback(raw)(publicKey, signingInputs)).rejects.toMatchObject({
      reason: 'locked',
      cause: underlying,
      message: 'Sign callback failed (locked): Not initialized'
    });
  });

  it('classifies any other failure as internal, and a non-Error throw too', async () => {
    await expect(
      buildSdkSignCallback(async () => {
        throw new Error('keystore IO failure');
      })(publicKey, signingInputs)
    ).rejects.toMatchObject({ reason: 'internal', message: 'Sign callback failed (internal): keystore IO failure' });
    expect(buildSignCallbackError('plain string')).toMatchObject({
      reason: 'internal',
      message: 'Sign callback failed (internal): plain string'
    });
  });
});

it('preserves a global access refusal through the SDK signer classification', async () => {
  const denied = Object.assign(new Error('Wallet access denied'), { code: 'WALLET_ACCESS_DENIED' });
  await expect(
    buildSdkSignCallback(async () => {
      throw denied;
    })(new Uint8Array(), new Uint8Array())
  ).rejects.toMatchObject({
    reason: 'wallet_access_denied',
    code: 'WALLET_ACCESS_DENIED',
    cause: denied
  });
});

it('restores the operation-scoped access refusal after an SDK or offscreen crossing', () => {
  const error = new Error('SDK execute failed');
  Reflect.apply(tagLockedSignReason, undefined, [error, 'wallet_access_denied']);
  expect(error).toMatchObject({ code: 'WALLET_ACCESS_DENIED', errorBeforeSubmit: true });
});
