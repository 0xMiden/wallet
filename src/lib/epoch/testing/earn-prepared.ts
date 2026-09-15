import type { PreparedAllocation, PreparedExecution } from '@epoch-protocol/epoch-intents-sdk';

export const PREPARED_OWNER = '0x1111111111111111111111111111111111111111';
export const PREPARED_RECIPIENT = '0x1234567890abcdef1234567890abcd';
export const PREPARED_FAUCET = '0xabcdef1234567890abcdef12345678';
export const PREPARED_TOKEN = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';

export function preparedAllocation(nonce: string, delivery: boolean, expires = '2000000000'): PreparedAllocation {
  return {
    sponsor: PREPARED_OWNER,
    nonce,
    expires,
    requestJson: JSON.stringify({
      chainId: '11155111',
      isRegisteredOnchain: true,
      sponsorSignature: '0x',
      witnessTypeString:
        'address tokenIn,uint256 tokenInAmount,address tokenOut,uint256 minTokenOut,uint256 destinationChainId,bytes4 taskType,address recipient' +
        (delivery ? ',string midenRecipientAccount,string midenFaucetId' : ''),
      compact: {
        arbiter: PREPARED_OWNER,
        sponsor: PREPARED_OWNER,
        nonce,
        expires,
        id: '1',
        lockTag: '0x000000000000000000000001',
        token: PREPARED_TOKEN,
        amount: '10000000',
        mandate: {
          tokenIn: PREPARED_TOKEN,
          tokenInAmount: '10000000',
          tokenOut: PREPARED_TOKEN,
          minTokenOut: '1',
          destinationChainId: delivery ? '999999999' : '11155111',
          taskType: '0x12345678',
          recipient: PREPARED_OWNER,
          ...(delivery ? { midenRecipientAccount: PREPARED_RECIPIENT, midenFaucetId: PREPARED_FAUCET } : {})
        }
      }
    })
  };
}

export function preparedExecution(): PreparedExecution {
  return { chainId: 11155111, allocations: [preparedAllocation('11', false), preparedAllocation('22', true)] };
}
