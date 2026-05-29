import React from 'react';

import { SEPOLIA_TESTNET_TOKENS, inputClass } from './shared';

interface TokenSelectProps {
  value: string;
  onChange: (address: string) => void;
}

export const TokenSelect: React.FC<TokenSelectProps> = ({ value, onChange }) => (
  <select className={inputClass} value={value} onChange={e => onChange(e.target.value)}>
    {SEPOLIA_TESTNET_TOKENS.map(token => (
      <option key={token.address} value={token.address}>
        {token.symbol}
      </option>
    ))}
  </select>
);
