import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import { cacheScope } from 'lib/miden-chain/native-asset';

/** Bind the source exactly without copying possible custom RPC credentials into a transaction. */
export const currentUsdcxFeeScope = (): string => bytesToHex(sha256(new TextEncoder().encode(cacheScope())));
