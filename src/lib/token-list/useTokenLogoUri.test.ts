import { act, renderHook, waitFor } from '@testing-library/react';

import { useTokenLogoUri } from './useTokenLogoUri';

const mockLoad = jest.fn();
// What the mocked loader last resolved to per network, as the runtime remembers it.
const mockSettled = new Map<string, unknown>();
let mockUpdated: ((network: string) => void) | undefined;
jest.mock('./runtime', () => ({
  loadTokenLogos: (network: string) => {
    const pending = mockLoad(network);
    void Promise.resolve(pending).then(logos => mockSettled.set(network, logos));
    return pending;
  },
  peekTokenLogos: (network: string) => mockSettled.get(network),
  onTokenListUpdated: (listener: (network: string) => void) => {
    mockUpdated = listener;
    return () => {
      mockUpdated = undefined;
    };
  }
}));
let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => id.toLowerCase() }));

beforeEach(() => {
  mockLoad.mockReset();
  mockSettled.clear();
  mockNetwork = 'testnet';
});

const renderLogo = (id?: string) =>
  renderHook((props: { id?: string }) => useTokenLogoUri(props.id), { initialProps: { id } });

it('is undefined with no id and loads nothing', async () => {
  mockLoad.mockResolvedValue(new Map([['mtst1aaa', 'https://x/a.png']]));
  const { result } = renderLogo(undefined);
  await act(async () => undefined);
  expect(result.current).toBeUndefined();
  expect(mockLoad).not.toHaveBeenCalled();
});

it('is undefined while the list loads, then the listed URL', async () => {
  let resolve: (m: Map<string, string>) => void = () => undefined;
  mockLoad.mockReturnValue(new Promise<Map<string, string>>(r => (resolve = r)));
  const { result } = renderLogo('mtst1aaa');
  expect(result.current).toBeUndefined();
  await act(async () => resolve(new Map([['mtst1aaa', 'https://x/a.png']])));
  expect(result.current).toBe('https://x/a.png');
});

it('matches an id given in another encoding', async () => {
  mockLoad.mockResolvedValue(new Map([['mtst1aaa', 'https://x/a.png']]));
  const { result } = renderLogo('MTST1AAA');
  await waitFor(() => expect(result.current).toBe('https://x/a.png'));
});

it.each(['unlisted', 'ETH', '0xabc'])('is undefined for %s without throwing', async id => {
  mockLoad.mockResolvedValue(new Map([['mtst1aaa', 'https://x/a.png']]));
  const { result } = renderLogo(id);
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());
  await act(async () => undefined);
  expect(result.current).toBeUndefined();
});

it('drops the logo when a refreshed list no longer has it', async () => {
  mockLoad.mockResolvedValueOnce(new Map([['mtst1aaa', 'https://x/a.png']]));
  const { result } = renderLogo('mtst1aaa');
  await waitFor(() => expect(result.current).toBe('https://x/a.png'));
  mockLoad.mockResolvedValueOnce(new Map());
  await act(async () => mockUpdated?.('testnet'));
  expect(result.current).toBeUndefined();
});

it('ignores a list loaded for another network until the new network loads', async () => {
  mockLoad.mockResolvedValueOnce(new Map([['mtst1aaa', 'https://x/a.png']]));
  const { result, rerender } = renderLogo('mtst1aaa');
  await waitFor(() => expect(result.current).toBe('https://x/a.png'));
  mockNetwork = 'devnet';
  mockLoad.mockReturnValueOnce(new Promise(() => undefined));
  rerender({ id: 'mtst1aaa' });
  expect(result.current).toBeUndefined();
});

it('renders nothing when an update notice reloads equal logos, and the new logo when they differ', async () => {
  mockLoad.mockResolvedValue(new Map([['mtst1aaa', 'https://x/a.png']]));
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useTokenLogoUri('mtst1aaa');
  });
  await waitFor(() => expect(result.current).toBe('https://x/a.png'));
  const rendersBefore = renders;

  mockLoad.mockResolvedValue(new Map([['mtst1aaa', 'https://x/a.png']]));
  await act(async () => mockUpdated?.('testnet'));
  expect(mockLoad).toHaveBeenCalledTimes(2);
  expect(renders).toBe(rendersBefore);

  mockLoad.mockResolvedValue(new Map([['mtst1aaa', 'https://x/b.png']]));
  await act(async () => mockUpdated?.('testnet'));
  expect(result.current).toBe('https://x/b.png');
});

/** The value each render of a fresh instance returned, first render first. */
const renderValues = (id: string) => {
  const values: (string | undefined)[] = [];
  renderHook(() => {
    const uri = useTokenLogoUri(id);
    values.push(uri);
    return uri;
  });
  return values;
};

it('draws a logo the realm already loaded on the first render of another instance', async () => {
  mockLoad.mockResolvedValue(new Map([['mtst1aaa', 'https://x/a.png']]));
  const { result } = renderLogo('mtst1aaa');
  await waitFor(() => expect(result.current).toBe('https://x/a.png'));

  const values = renderValues('mtst1aaa');
  expect(values[0]).toBe('https://x/a.png');
  // Lets the second instance's own load land inside act.
  await act(async () => undefined);
});

it('is undefined on the first render before any load settled', () => {
  mockLoad.mockReturnValue(new Promise(() => undefined));
  expect(renderValues('mtst1aaa')[0]).toBeUndefined();
});
