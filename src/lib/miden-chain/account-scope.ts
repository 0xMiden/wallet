export interface AccountScope {
  /** The current wallet account ID (not signing material). */
  accountId: string;
  network: string;
  rpcUrl: string;
}
