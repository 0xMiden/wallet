import { MidenNetwork } from 'lib/miden/types';

export const NETWORK_STORAGE_ID = 'network_id';

export enum MIDEN_NETWORK_NAME {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
  DEVNET = 'devnet',
  LOCALNET = 'localnet'
}

export enum MIDEN_TRANSPORT_LAYER_NAME {
  TESTNET = 'testnet',
  LOCALNET = 'localnet'
}

export const MIDEN_NETWORK_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.MAINNET, 'https://api.miden.io'], // Placeholder
  [MIDEN_NETWORK_NAME.TESTNET, 'https://rpc.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://rpc.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:57291']
]);

export const MIDEN_PROVING_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://tx-prover.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://tx-prover.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:50051']
]);

export const MIDEN_FAUCET_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://faucet.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://faucet.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:57291']
]);

export const MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://transport.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://127.0.0.1']
]);

export const MIDEN_NETWORKS: MidenNetwork[] = [
  {
    rpcBaseURL: 'https://rpc.testnet.miden.io',
    id: MIDEN_NETWORK_NAME.TESTNET,
    name: 'Testnet',
    autoSync: true
  },
  {
    rpcBaseURL: 'https://rpc.devnet.miden.io',
    id: MIDEN_NETWORK_NAME.DEVNET,
    name: 'Devnet',
    autoSync: true
  },
  { rpcBaseURL: 'localhost:57291', id: MIDEN_NETWORK_NAME.LOCALNET, name: 'Localnet', autoSync: true }
];

export enum MidenTokens {
  Miden
}

export const TOKEN_MAPPING = {
  [MidenTokens.Miden]: { faucetId: 'mtst1aqmat9m63ctdsgz6xcyzpuprpulwk9vg_qruqqypuyph' }
};
