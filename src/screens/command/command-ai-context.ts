import { useCallback, useMemo } from 'react';

import { deriveBridgeRoutes } from 'lib/bridge/catalog';
import type { BridgeRouteSummary, EarnSubjectSummary, OrchestratorWalletContext } from 'lib/command-ai/orchestrator';
import { DEFAULT_LIQUID_TICKERS, type RedactionContact } from 'lib/command-ai/redactor';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { getSwapTokens } from 'lib/miden/swap/tokens';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { getNativeAssetIdSync, getVerificationBaseFeeSync } from 'lib/miden-chain/native-asset';
import type { TokenPrices } from 'lib/prices';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectEarnVaultCatalog, selectEarnVaults, selectMidenUsdcFaucetId } from 'lib/remote-config/values';
import { useWalletStore } from 'lib/store';

export function useCommandAiWalletData(
  scope: AccountScope,
  assets: readonly TokenBalanceData[],
  tokenPrices: TokenPrices
) {
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const settingsContacts = useWalletStore(state => state.settings?.contacts);
  const accounts = useWalletStore(state => state.accounts);

  const contacts = useMemo<RedactionContact[]>(() => {
    const seen = new Set<string>();
    const list: RedactionContact[] = [];
    for (const c of settingsContacts ?? []) {
      if (!c.address || !c.name) continue;
      seen.add(c.address.toLowerCase());
      list.push({ id: `contact:${c.address}`, name: c.name, address: c.address, network: c.network });
    }
    for (const acc of accounts ?? []) {
      if (!acc.publicKey || !acc.name || seen.has(acc.publicKey.toLowerCase())) continue;
      list.push({ id: `account:${acc.publicKey}`, name: acc.name, address: acc.publicKey });
    }
    return list;
  }, [settingsContacts, accounts]);

  // Placeholders cover every stored row: `assets` leaves out hidden tokens and is empty when the
  // balance proof is old, and a typed symbol is replaced in both cases.
  const storedRows = useWalletStore(state => state.balances[scope.accountId]);
  const heldNicheTickers = useMemo(
    () =>
      [...assets, ...(storedRows ?? [])]
        .filter(a => a.metadata.symbol && !DEFAULT_LIQUID_TICKERS.has(a.metadata.symbol.trim().toUpperCase()))
        .map(a => ({ symbol: a.metadata.symbol, tokenId: a.tokenId })),
    [assets, storedRows]
  );

  const getWalletContext = useCallback(
    (earnPositions: EarnSubjectSummary[] = []): OrchestratorWalletContext => {
      const bridgeRoutes: BridgeRouteSummary[] = deriveBridgeRoutes(bridgeConfig)
        .filter(r => !(r.provider === 'epoch' && r.mode === 'receive'))
        .map(r => {
          const evmSide = r.mode === 'receive' ? r.source : r.destination;
          return {
            id: r.id,
            provider: r.provider,
            mode: r.mode,
            sourceSymbol: r.source.symbol,
            sourceNetwork: r.source.network,
            destinationSymbol: r.destination.symbol,
            destinationNetwork: r.destination.network,
            ...(evmSide.kind === 'erc20' ? { contractAddress: evmSide.address } : {})
          };
        });
      const catalog = selectEarnVaultCatalog(bridgeConfig);
      const earnCollateralId = selectMidenUsdcFaucetId(bridgeConfig);
      const earnVaults: EarnSubjectSummary[] = catalog
        ? catalog.map(v => ({
            id: v.listing.id,
            name: v.listing.name,
            symbol: v.underlying.symbol,
            ...(earnCollateralId ? { collateralFaucetId: earnCollateralId } : {})
          }))
        : selectEarnVaults(bridgeConfig).map(v => ({
            id: v.id,
            name: v.name,
            symbol: 'USDCx',
            ...(earnCollateralId ? { collateralFaucetId: earnCollateralId } : {})
          }));

      return {
        accountPublicKey: scope.accountId,
        networkName: scope.network,
        balances: assets,
        tokenPrices,
        contacts,
        swapTokens: getSwapTokens(),
        bridgeRoutes,
        earnVaults,
        earnPositions,
        nativeFaucetId: getNativeAssetIdSync(),
        verificationBaseFee: getVerificationBaseFeeSync()
      };
    },
    [scope.accountId, scope.network, assets, tokenPrices, contacts, bridgeConfig]
  );

  const loadEarnPositions = useCallback(async (): Promise<EarnSubjectSummary[]> => {
    try {
      const [{ fetchEarnPositions }, { mapEarnPosition }] = await Promise.all([
        import('lib/epoch'),
        import('screens/earn-flow/earn-mapping')
      ]);
      const res = await fetchEarnPositions({ owners: [scope.accountId] });
      const listed = selectEarnVaults(bridgeConfig);
      return res.positions
        .map(pos => mapEarnPosition(pos, listed))
        .map(mapped => ({
          id: mapped.id,
          name: mapped.name ?? mapped.protocol,
          symbol: mapped.asset,
          withdrawable: mapped.withdrawable,
          decimals: mapped.decimals
        }));
    } catch {
      return [];
    }
  }, [scope.accountId, bridgeConfig]);

  return { contacts, heldNicheTickers, getWalletContext, loadEarnPositions };
}
