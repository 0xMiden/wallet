import type { Address, Hex } from 'viem';

/**
 * Circle xReserve on Ethereum Sepolia. The same address is used on Arc Testnet.
 * Source: Circle's "xReserve supported blockchains and domains" page.
 */
export const XRESERVE_SEPOLIA_ADDRESS: Address = '0x008888878f94C0d87defdf0B07f46B93C1934442';

/**
 * Circle's official USDC on Ethereum Sepolia. This is NOT the token the Epoch
 * route uses (`BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS`, 18 decimals). xReserve
 * only accepts this token.
 */
export const CIRCLE_USDC_SEPOLIA_ADDRESS: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const CIRCLE_USDC_DECIMALS = 6;
export const CIRCLE_USDC_SYMBOL = 'USDC';

/**
 * Circle's remote-domain id for Miden. Circle assigned 10007 for testnet and
 * mainnet, but did not register it on the Sepolia xReserve contract yet. A
 * deposit to an unregistered domain reverts with `RemoteDomainNotRegistered`.
 */
export const USDCX_MIDEN_REMOTE_DOMAIN = 10007;

/**
 * The remote domain the wallet sends deposits to.
 *
 * Stand-in: 10005 is Movement Bardock testnet. It is registered on Sepolia
 * with a USDC remote token, it takes the same call shape as Miden (a raw
 * 32-byte recipient and empty hook data), and its explorer shows the minted
 * USDCx per account, so a test deposit can be checked end to end:
 * https://explorer.movementnetwork.xyz/account/<recipient>?network=bardock+testnet
 *
 * When `isRemoteDomainRegistered(USDCX_MIDEN_REMOTE_DOMAIN)` on the Sepolia
 * xReserve returns true, set this to `USDCX_MIDEN_REMOTE_DOMAIN` and set
 * `USDCX_STANDIN_RECIPIENT` to `undefined`.
 */
export const USDCX_REMOTE_DOMAIN = 10005;

/**
 * Test-only recipient for the stand-in domain. A Miden account id means
 * nothing on Movement, so while `USDCX_REMOTE_DOMAIN` is the stand-in, the
 * deposit goes to this 32-byte Movement Bardock account instead of the
 * encoded Miden id. Movement is a Move VM chain, so any 32 bytes is a valid
 * account address; this one is random and nobody holds its key. The minted
 * USDCx is visible on the explorer and is lost. `undefined` uses the encoded
 * Miden account id, which is the production behaviour.
 */
export const USDCX_STANDIN_RECIPIENT: Hex | undefined =
  '0x937866b6f6983c030bbb31603017276fbe3c46c33b0763380e706c505da447c9';

/** The single USDCx faucet. Currently the self-controlled testnet deployment. */
export const USDCX_FAUCET_ID_BECH32 = 'mtst1ap50kfl4v7nmlufupa2akrh345e0hfke';
export const USDCX_SYMBOL = 'USDCx';
export const USDCX_DECIMALS = 6;

/** BURN root recorded by the faucet deployment; checked against the running SDK before sending. */
export const USDCX_BURN_SCRIPT_ROOT = '0x1106bde3e27e3ba82096917427fe798c54ce0bb5997a145d8e8157fe22b70935';
export const USDCX_BURN_TAG = 0x4255524e;
export const USDCX_MIN_BURN_SLOT = 'miden::standards::faucets::policies::burn::min_burn_amount::min_burn_amount';
/** Circle domains are not EVM chain ids or Miden remote-domain ids. */
export const USDCX_WITHDRAWAL_DESTINATION = { chainId: 11155111, domain: 0 };

/** The fee ceiling passed to `depositToRemote`. Circle's fee for Miden is not confirmed yet. */
export const USDCX_DEPOSIT_MAX_FEE = 0n;
/** Circle confirmed that empty hook data is accepted for Miden. */
export const USDCX_DEPOSIT_HOOK_DATA: Hex = '0x';

export const XRESERVE_ATTESTATION_API_TESTNET = 'https://xreserve-api-testnet.circle.com';
export const XRESERVE_ATTESTATION_API_MAINNET = 'https://xreserve-api.circle.com';
/** The attestation API the wallet polls. The wallet bridges on Sepolia only today. */
export const XRESERVE_ATTESTATION_API = XRESERVE_ATTESTATION_API_TESTNET;

/**
 * The parts of the xReserve ABI the wallet calls. Source: Circle's
 * `evm-xreserve-contracts` at a571cbe, `src/modules/x-reserve/*.sol`.
 */
export const XRESERVE_ABI = [
  {
    type: 'function',
    name: 'depositToRemote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'value', type: 'uint256' },
      { name: 'remoteDomain', type: 'uint32' },
      { name: 'remoteRecipient', type: 'bytes32' },
      { name: 'localToken', type: 'address' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'isRemoteDomainRegistered',
    stateMutability: 'view',
    inputs: [{ name: 'remoteDomain', type: 'uint32' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'error',
    name: 'RemoteDomainNotRegistered',
    inputs: [{ name: 'remoteDomain', type: 'uint32' }]
  }
] as const;

export const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

export const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;
