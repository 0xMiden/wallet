import { handleSecretCopyEvent, selectedFieldText, writeSecretToClipboard } from './secret-clipboard';

const mockNativeWrite = jest.fn();
const mockClipboardWrite = jest.fn();
let mockIsMobile = true;

jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ write: (...args: unknown[]) => mockNativeWrite(...args) })
}));

jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

jest.mock('lib/platform', () => ({ isMobile: () => mockIsMobile }));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function copyEvent() {
  const setData = jest.fn();
  const preventDefault = jest.fn();
  const event = { clipboardData: { setData }, preventDefault };
  return { event, setData, preventDefault };
}

describe('secret-clipboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile = true;
    mockNativeWrite.mockResolvedValue(undefined);
    mockClipboardWrite.mockResolvedValue(undefined);
  });

  it('writes a secret through the native secret clipboard on mobile, asking for the 60 s clear', async () => {
    await writeSecretToClipboard('alpha beta');
    expect(mockNativeWrite).toHaveBeenCalledWith({ string: 'alpha beta', clearAfterMs: 60_000 });
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('writes a secret through the plain clipboard off mobile', async () => {
    mockIsMobile = false;
    await writeSecretToClipboard('alpha beta');
    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'alpha beta' });
    expect(mockNativeWrite).not.toHaveBeenCalled();
  });

  it('rejects when the native write is refused', async () => {
    mockNativeWrite.mockRejectedValue(new Error('refused'));
    await expect(writeSecretToClipboard('x')).rejects.toThrow('refused');
  });

  it('routes a mobile copy event to the native write and leaves the event data empty', () => {
    const { event, setData, preventDefault } = copyEvent();
    handleSecretCopyEvent(event, 'alpha beta');
    expect(preventDefault).toHaveBeenCalled();
    expect(setData).not.toHaveBeenCalled();
    expect(mockNativeWrite).toHaveBeenCalledWith({ string: 'alpha beta', clearAfterMs: 60_000 });
  });

  it("writes a web copy event's data itself", () => {
    mockIsMobile = false;
    const { event, setData, preventDefault } = copyEvent();
    handleSecretCopyEvent(event, 'alpha beta');
    expect(setData).toHaveBeenCalledWith('text/plain', 'alpha beta');
    expect(preventDefault).toHaveBeenCalled();
    expect(mockNativeWrite).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('writes nothing natively for an empty selection on mobile', () => {
    const { event, preventDefault } = copyEvent();
    handleSecretCopyEvent(event, '');
    expect(preventDefault).toHaveBeenCalled();
    expect(mockNativeWrite).not.toHaveBeenCalled();
  });

  it('never logs the secret when the native write from a copy event fails', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockNativeWrite.mockRejectedValue(new Error('refused'));
    const { event } = copyEvent();
    handleSecretCopyEvent(event, 'alpha beta');
    await flush();
    expect(error).toHaveBeenCalled();
    for (const call of error.mock.calls) {
      for (const arg of call) {
        expect(String(arg instanceof Error ? `${arg.message} ${arg.stack}` : arg)).not.toContain('alpha beta');
      }
    }
    error.mockRestore();
  });

  it('reads only the selected part of a field', () => {
    const field = document.createElement('textarea');
    field.value = 'abcdef';
    field.setSelectionRange(1, 4);
    expect(selectedFieldText(field)).toBe('bcd');
  });
});
