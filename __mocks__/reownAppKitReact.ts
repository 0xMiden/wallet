const disconnectedAccount = {
  address: undefined,
  chainId: undefined,
  isConnected: false,
  status: 'disconnected'
};

interface MockNetwork {
  id: string | number;
}

export const createAppKit = jest.fn((options: { networks?: MockNetwork[] } = {}) => {
  let networks = [...(options.networks ?? [])];
  let active = networks[0];
  const relayer = { connected: false, on: jest.fn() };
  return {
    setThemeMode: jest.fn(),
    ready: jest.fn(async () => {}),
    subscribeState: jest.fn(() => () => {}),
    getUniversalProvider: jest.fn(async () => ({ client: { core: { relayer } } })),
    getCaipNetworks: jest.fn(() => networks),
    getCaipNetwork: jest.fn(() => active),
    addNetwork: jest.fn((_namespace: string, network: MockNetwork) => {
      if (!networks.some(entry => entry.id === network.id)) networks = [...networks, network];
    }),
    removeNetwork: jest.fn((_namespace: string, id: string | number) => {
      networks = networks.filter(network => network.id !== id);
    }),
    setCaipNetwork: jest.fn((network: MockNetwork) => {
      active = network;
    })
  };
});
export const useAppKit = jest.fn(() => ({ open: jest.fn(), close: jest.fn() }));
export const useAppKitAccount = jest.fn(() => disconnectedAccount);
export const useAppKitProvider = jest.fn(() => ({ walletProvider: undefined }));
export const useDisconnect = jest.fn(() => ({ disconnect: jest.fn() }));
