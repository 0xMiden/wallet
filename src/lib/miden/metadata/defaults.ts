import { UNKNOWN_TOKEN_IDENTITY } from './scale';
import { AssetMetadata } from './types';

export const MIDEN_METADATA: AssetMetadata = {
  decimals: 6,
  symbol: 'MIDEN',
  name: 'Miden'
};

export const EMPTY_ASSET_METADATA: AssetMetadata = {
  decimals: 0,
  symbol: '',
  name: ''
};

export const DEFAULT_TOKEN_METADATA: AssetMetadata = {
  // The 6 decimals in here are a placeholder so consumers have something to
  // read, NOT a fact about any faucet — which is what `scaleIsUnknown` says.
  // `hasKnownScale` recognises pre-marker cached copies by these same three
  // fields, so they are declared once, next to the predicate.
  ...UNKNOWN_TOKEN_IDENTITY,
  scaleIsUnknown: true
};
