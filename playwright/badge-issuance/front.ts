export const useAccount = () => ({ name: 'Badge QA', publicKey: 'fixture-account-a' });
export const useNetwork = () => ({
  id: new URLSearchParams(location.search).get('network') ?? 'testnet',
  name: new URLSearchParams(location.search).get('network') === 'mainnet' ? 'Mainnet' : 'Testnet'
});
