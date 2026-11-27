// The tokens the prototype wallet holds. The faucet ids are real testnet ones, so the logos are the
// app's; the balances are invented for the prototype.
import { IETH, USDCX } from './fixture';

export interface ProtoToken {
  id: string;
  symbol: string;
  name: string;
  balance: number;
}

export const PROTO_TOKENS: ProtoToken[] = [
  { id: USDCX, symbol: 'USDCX', name: 'USDCX', balance: 140.5 },
  { id: IETH, symbol: 'iETH', name: 'Test iETH', balance: 0.82 }
];
