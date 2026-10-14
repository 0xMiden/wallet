import type { Hex } from 'viem';

/** The 24-byte hook name the Generic Executor looks for in composable hook data (`circle-generic-executor`). */
export const CCTP_EXECUTOR_HOOK_NAME = 'circle-generic-executor';
/** The hook name Circle's forwarding service looks for; its frame carries no payload for an EVM destination. */
export const CCTP_FORWARD_HOOK_NAME = 'cctp-forward';
/** The one composable hook-data version the executor accepts. */
export const CCTP_HOOK_VERSION = 1;
/** The executor payload version `GenericExecutor._decodeAndValidatePayload` accepts. */
export const CCTP_EXECUTOR_PAYLOAD_VERSION = 1;
/** A standard CCTP V2 transfer, which Circle prices at no protocol fee on the routes the wallet uses. */
export const CCTP_STANDARD_FINALITY_THRESHOLD = 2000;

export const CIRCLE_USDC_DECIMALS = 6;
export const CIRCLE_USDC_SYMBOL = 'USDC';

// The USDCx faucet is the chain's native asset: read its id through `requireUsdcxFaucetId` (`./withdrawal`).
export const USDCX_SYMBOL = 'USDCx';
export const USDCX_DECIMALS = 6;

export const USDCX_BURN_TAG = 0x4255524e;
/** The withdrawal attachment's scheme: `StandardNoteAttachment::UsdcxBurn` in the 0.17.1 standards. */
export const USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME = 5;
export const USDCX_MIN_BURN_SLOT = 'miden::standards::faucets::policies::burn::min_burn_amount::min_burn_amount';
export const USDCX_ALLOWED_NOTE_SCRIPTS_SLOT = 'miden::standards::auth::network_account::allowed_note_scripts';

/** The fee ceiling passed to `depositToRemote`. Circle's fee for Miden is not confirmed yet. */
export const USDCX_DEPOSIT_MAX_FEE = 0n;
/** Circle confirmed that empty hook data is accepted for Miden. */
export const USDCX_DEPOSIT_HOOK_DATA: Hex = '0x';

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

export const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
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

/**
 * The CCTP V2 `TokenMessengerV2` entry point the executor route burns through: a standard transfer whose
 * mint recipient and destination caller are both the executor, with the xReserve deposit as hook data.
 */
export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' }
    ],
    outputs: []
  }
] as const;

/**
 * Circle's Generic Executor on Arc (`GenericExecutor.execute`): receives the attested CCTP message, which
 * mints to the executor, then hands the minted USDC to the handler named in the executor hook. Anyone may
 * call it, so the wallet does when Circle's forwarder does not.
 */
export const GENERIC_EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payload', type: 'bytes' },
      { name: 'proof', type: 'bytes' }
    ],
    outputs: []
  },
  {
    type: 'event',
    name: 'Executed',
    inputs: [
      { name: 'transport', type: 'bytes4', indexed: true },
      { name: 'version', type: 'uint8', indexed: false },
      { name: 'handler', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'bytes32', indexed: false }
    ]
  }
] as const;

/**
 * Circle's `TokenMessengerWithFees` entry point for a burn with a signed quote: the quote is bound to the
 * amount, destination, token, destination caller and hook data, and its forward fee pays Circle to execute
 * the message on Arc. The fee is taken in source USDC on top of the amount, so the burn amount arrives whole.
 */
export const TOKEN_MESSENGER_WITH_FEES_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHookAndFees',
    stateMutability: 'payable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'hookData', type: 'bytes' },
      {
        name: 'claim',
        type: 'tuple',
        components: [
          { name: 'signedQuote', type: 'bytes' },
          { name: 'refundAddress', type: 'address' }
        ]
      }
    ],
    outputs: []
  }
] as const;
