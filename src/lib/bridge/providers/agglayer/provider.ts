import type { AgglayerClient } from './deposit';

export function agglayerReadClient(_chainId: number): AgglayerClient {
  throw new Error('Agglayer read client unavailable');
}
