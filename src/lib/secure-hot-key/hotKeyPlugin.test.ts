import type { HotKeyPlugin } from './hotKeyPlugin';

const mockPlugin: jest.Mocked<HotKeyPlugin> = {
  generateHotKey: jest.fn(),
  signWithHotKey: jest.fn(),
  deleteHotKey: jest.fn(),
  revealHotKey: jest.fn()
};
const mockRegisterPlugin = jest.fn((_name: string) => mockPlugin);

jest.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => mockRegisterPlugin(name)
}));

describe('secure-hot-key hotKeyPlugin', () => {
  it('registers the Capacitor HotKey plugin handle', async () => {
    const { HotKey } = await import('./hotKeyPlugin');

    expect(mockRegisterPlugin).toHaveBeenCalledWith('HotKey');
    expect(HotKey).toBe(mockPlugin);
  });
});
