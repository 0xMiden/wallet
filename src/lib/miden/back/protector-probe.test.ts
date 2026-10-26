import { probeHardwareProtector } from './protector-probe';

const mockHasHardwareProtector = jest.fn();
const mockHasPasswordProtector = jest.fn();
jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    hasHardwareProtector: () => mockHasHardwareProtector(),
    hasPasswordProtector: () => mockHasPasswordProtector()
  }
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('probeHardwareProtector', () => {
  it.each([true, false])('answers the hardware read (%s) when it resolves', async hasHardware => {
    mockHasHardwareProtector.mockResolvedValue(hasHardware);

    await expect(probeHardwareProtector()).resolves.toBe(hasHardware);
    expect(mockHasPasswordProtector).not.toHaveBeenCalled();
  });

  // Reading both up front would let a failed password read reject a probe the hardware read answered.
  it('ignores a failing password read when the hardware read answers', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockHasPasswordProtector.mockRejectedValue(new Error('pw-boom'));

    await expect(probeHardwareProtector()).resolves.toBe(true);
  });

  it('answers no hardware when the hardware read fails and a password key exists', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('hw-boom'));
    mockHasPasswordProtector.mockResolvedValue(true);

    await expect(probeHardwareProtector()).resolves.toBe(false);
  });

  it('answers hardware when the hardware read fails and no password key exists', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('hw-boom'));
    mockHasPasswordProtector.mockResolvedValue(false);

    await expect(probeHardwareProtector()).resolves.toBe(true);
  });

  it('rejects with both causes, in the message and the cause, when both reads fail', async () => {
    const hardwareError = new Error('hw-boom');
    const passwordError = 'pw-boom';
    mockHasHardwareProtector.mockRejectedValue(hardwareError);
    mockHasPasswordProtector.mockRejectedValue(passwordError);

    const failure = await probeHardwareProtector().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty('message', 'both protector reads failed (hardware: hw-boom; password: pw-boom)');
    expect(failure).toHaveProperty('cause', { hardwareError, passwordError });
  });
});
