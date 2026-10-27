export type ProviderReceiptBackend = (value: unknown, expectedEpoch: number) => Promise<void>;

let backend: ProviderReceiptBackend | undefined;

export function installProviderReceiptBackend(value: ProviderReceiptBackend | undefined): void {
  backend = value;
}

export function getProviderReceiptBackend(): ProviderReceiptBackend | undefined {
  return backend;
}
