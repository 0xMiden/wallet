import { MidenClient, NetworkId } from '@miden-sdk/miden-sdk/lazy';
import { forbidden } from './rpc';

export * from '../../../src/lib/miden-chain/networks-config';
export const getNetworkId = () => NetworkId.testnet();
export const ensureSdkWasmReady = () => MidenClient.ready();
export const getRpcEndpoint = () => forbidden('getRpcEndpoint outside controlled reader');
