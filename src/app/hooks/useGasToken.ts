import { getNativeDisplayMetadataSync } from 'lib/miden/metadata/native';

export const useGasToken = () => {
  return {
    logo: 'misc/token-logos/film.png',
    symbol: 'ф',
    assetName: 'miden',
    metadata: getNativeDisplayMetadataSync(),
    isDcpNetwork: true
  };
};
