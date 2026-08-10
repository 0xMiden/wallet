const disconnectedAccount = {
  address: undefined,
  chainId: undefined,
  isConnected: false,
  status: 'disconnected'
};

export const createAppKit = jest.fn(() => ({ setThemeMode: jest.fn() }));
export const useAppKit = jest.fn(() => ({ open: jest.fn(), close: jest.fn() }));
export const useAppKitAccount = jest.fn(() => disconnectedAccount);
export const useAppKitProvider = jest.fn(() => ({ walletProvider: undefined }));
export const useDisconnect = jest.fn(() => ({ disconnect: jest.fn() }));
