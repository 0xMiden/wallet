export const RouterController = {
  reset: jest.fn(),
  push: jest.fn(),
  replace: jest.fn()
};

// The stored connection status, as a fresh page with no session reads it.
export const StorageUtil = {
  getConnectionStatus: jest.fn((): string | undefined => undefined),
  setConnectionStatus: jest.fn(),
  deleteConnectedConnectorId: jest.fn(),
  removeConnectedNamespace: jest.fn()
};
