import React, { useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { TokenLogo } from 'components/TokenLogo';
import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { DepositSheet } from './parts';
import * as s from './styles';
import type { DepositNetworkDisplay } from './types';

/** One token on one network that the sheet offers. */
export interface DepositTokenOption {
  /** Unique over every network. */
  id: string;
  /** The source token's name. */
  symbol: string;
  /** The token that arrives in the wallet. */
  receivedSymbol: string;
  /** The Miden faucet that keys the logo. `undefined` draws the default mark. */
  logoFaucetId: string | undefined;
  network: DepositNetworkDisplay;
}

export interface DepositTokenSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The network chips, in order. */
  networks: readonly DepositNetworkDisplay[];
  /** The network the chips show when the sheet opens: the network of the current token. */
  networkId: string;
  /** Every token on every network, in order. */
  tokens: readonly DepositTokenOption[];
  /** The current token, which takes the check mark. */
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** "Connect a wallet instead": the way to every other token. */
  onConnectWallet: () => void;
}

function matches(option: DepositTokenOption, query: string): boolean {
  return [option.symbol, option.receivedSymbol, option.network.name].some(text => text.toLowerCase().includes(query));
}

/**
 * The "Select a token" sheet (mock-up `sheet === 'token'`): the search field, the network chips and the token list under
 * the heading "Deposit in Bread". Without a search, the list shows the tokens of the chosen chip. A search hides the
 * chips and finds tokens on every network by token, received token or network name. The sheet ends on the text action
 * "Connect a wallet instead".
 */
export const DepositTokenSheet: React.FC<DepositTokenSheetProps> = ({
  open,
  onOpenChange,
  networks,
  networkId,
  tokens,
  selectedId,
  onSelect,
  onConnectWallet
}) => {
  const { t } = useTranslation();
  const [chip, setChip] = useState(networkId);
  const [query, setQuery] = useState('');

  // Each time the sheet opens it starts on the current network with an empty search, as the mock-up's sheet does.
  useEffect(() => {
    if (!open) return;
    setChip(networkId);
    setQuery('');
  }, [open, networkId]);

  const search = query.trim().toLowerCase();
  const shown = search
    ? tokens.filter(option => matches(option, search))
    : tokens.filter(option => option.network.id === chip);

  return (
    <DepositSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('selectAToken')}
      screenKey="deposit-token"
      data-testid="deposit-token-sheet"
    >
      <label className={s.SEARCH}>
        <Icon name={IconName.Search} fill="currentColor" aria-hidden="true" className={s.ICON_20} />
        <input
          type="text"
          autoComplete="off"
          placeholder={t('searchForTokens')}
          aria-label={t('searchForTokens')}
          value={query}
          onChange={event => setQuery(event.target.value)}
          className={s.SEARCH_INPUT}
          data-testid="deposit-token-search"
        />
      </label>
      {!search && (
        <div className={s.NETS} data-testid="deposit-token-networks">
          {networks.map(network => (
            <button
              key={network.id}
              type="button"
              aria-pressed={network.id === chip}
              onClick={() => {
                hapticSelection();
                setChip(network.id);
              }}
              className={cn(s.CHIP, network.id === chip && s.CHIP_PRESSED)}
              data-testid={`deposit-token-network-${network.id}`}
            >
              {network.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col" data-testid="deposit-token-list">
        {shown.length > 0 && <p className={s.SEC}>{t('depositFlowTokenGroupInBread')}</p>}
        {shown.map(option => (
          <button
            key={option.id}
            type="button"
            aria-pressed={option.id === selectedId}
            onClick={() => {
              hapticLight();
              onSelect(option.id);
            }}
            className={s.ASSET}
            data-testid={`deposit-token-${option.id}`}
          >
            <TokenLogo faucetId={option.logoFaucetId} size="md" />
            <span className="min-w-0">
              <b className={s.ASSET_NAME}>{option.symbol}</b>
              <small className={s.ASSET_SMALL}>
                {search
                  ? t('depositFlowTokenOnNetworkArrivesAs', {
                      network: option.network.name,
                      token: option.receivedSymbol
                    })
                  : t('depositFlowTokenArrivesAs', { token: option.receivedSymbol })}
              </small>
            </span>
            {option.id === selectedId ? (
              <Icon name={IconName.Checkmark} fill="currentColor" aria-hidden="true" className={s.ICON_20} />
            ) : (
              <span />
            )}
          </button>
        ))}
        {search && shown.length === 0 && (
          <p className={cn(s.NOTE, 'px-0 py-3')} role="status" data-testid="deposit-token-no-match">
            {t('depositFlowTokenNoMatch', { query: query.trim() })}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          hapticLight();
          onConnectWallet();
        }}
        className={s.TEXT_ACTION}
        data-testid="deposit-token-connect-wallet"
      >
        {t('depositFlowConnectWalletInstead')}
      </button>
    </DepositSheet>
  );
};
