import { act, renderHook } from '@testing-library/react';

import useCopyToClipboard from './useCopyToClipboard';

function makeField(value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.value = value;
  document.body.appendChild(input);
  return input;
}

function setFieldRef(ref: { current: HTMLInputElement | null }, value: HTMLInputElement): void {
  ref.current = value;
}

describe('useCopyToClipboard async clipboard writes', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('sets copied only after the clipboard write resolves', async () => {
    let resolveWrite!: () => void;
    const write = new Promise<void>(resolve => {
      resolveWrite = resolve;
    });
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: jest.fn(() => write) },
      configurable: true
    });

    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('wallet-address');
    setFieldRef(result.current.fieldRef, field);

    act(() => {
      result.current.copy();
    });
    expect(result.current.copied).toBe(false);

    await act(async () => {
      resolveWrite();
      await write;
    });

    expect(result.current.copied).toBe(true);
  });

  it('keeps copied false when the clipboard write rejects', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: jest.fn(() => Promise.reject(new Error('clipboard denied'))) },
      configurable: true
    });

    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('seed phrase');
    setFieldRef(result.current.fieldRef, field);

    await act(async () => {
      result.current.copy();
      await Promise.resolve();
    });

    expect(result.current.copied).toBe(false);
  });
});
