export const BRIDGE_ASSET_ABI = [
  // Human readable abi
  'function bridgeAsset(uint32 destinationNetwork,address destinationAddress,uint256 amount,address token,bool forceUpdateGlobalExitRoot,bytes calldata permitData)'
];
// When the testnet indexer renumbered Miden's exits from network 78 to the rollup id (86, `getAgglayerRollupId`), in
// unix seconds like a row's `initiatedAt`. It serves nothing under 78 any more, so it gates only one thing: an unpinned
// row initiated before this whose exit a search of its address's whole history missed is retired (#1325); a later row
// never is. The issue's evidence dates the switch only to the day (the last network-78 claim is on 2026-09-08), so this
// is the start of that day, UTC: a row from later that day is still polled rather than retired while it might settle.
export const MIDEN_CHAIN_ID_RENUMBERED_AT = Date.parse('2026-09-08T00:00:00Z') / 1000;
/**
 * Source symbol of the only asset the AggLayer delivery sender delivers. The sender
 * is the bridged-ETH faucet itself, so its notes can settle only a native ETH
 * deposit tracker, never an ERC-20 one with the same base-unit amount.
 */
export const AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL = 'ETH';
/**
 * TRNSK on Sepolia: the ERC-20 that Transak staging delivers for a "USDC on ethereum" buy. The buy flow bridges it
 * to Miden through the Agglayer bridge.
 */
export const TRNSK_SEPOLIA_ADDRESS = '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b';
export const TRNSK_DECIMALS = 18;
export const TRNSK_SYMBOL = 'TRNSK';
/**
 * Miden faucet (bech32) that mints bridged TRNSK. It is not known until the first testnet deposit. While it is
 * `undefined`, the buy watcher matches the bridged note by its amount only.
 */
export const AGGLAYER_TRNSK_FAUCET_ID: string | undefined = undefined;

export const AGGLAYER_BRIDGE_ABI = [
  {
    inputs: [],
    stateMutability: 'nonpayable',
    type: 'constructor'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'target',
        type: 'address'
      }
    ],
    name: 'AddressEmptyCode',
    type: 'error'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'account',
        type: 'address'
      }
    ],
    name: 'AddressInsufficientBalance',
    type: 'error'
  },
  {
    inputs: [],
    name: 'AlreadyClaimed',
    type: 'error'
  },
  {
    inputs: [],
    name: 'AmountDoesNotMatchMsgValue',
    type: 'error'
  },
  {
    inputs: [],
    name: 'BridgeAddressNotAllowed',
    type: 'error'
  },
  {
    inputs: [],
    name: 'DestinationNetworkInvalid',
    type: 'error'
  },
  {
    inputs: [],
    name: 'EtherTransferFailed',
    type: 'error'
  },
  {
    inputs: [],
    name: 'FailedInnerCall',
    type: 'error'
  },
  {
    inputs: [],
    name: 'FailedProxyDeployment',
    type: 'error'
  },
  {
    inputs: [],
    name: 'GasTokenNetworkMustBeZeroOnEther',
    type: 'error'
  },
  {
    inputs: [],
    name: 'GlobalExitRootInvalid',
    type: 'error'
  },
  {
    inputs: [],
    name: 'InvalidGlobalIndex',
    type: 'error'
  },
  {
    inputs: [],
    name: 'InvalidInitializeFunction',
    type: 'error'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'proxyAdmin',
        type: 'address'
      }
    ],
    name: 'InvalidProxyAdmin',
    type: 'error'
  },
  {
    inputs: [],
    name: 'InvalidSmtProof',
    type: 'error'
  },
  {
    inputs: [],
    name: 'InvalidZeroAddress',
    type: 'error'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'proxyAdmin',
        type: 'address'
      }
    ],
    name: 'InvalidZeroProxyAdminOwner',
    type: 'error'
  },
  {
    inputs: [],
    name: 'MerkleTreeFull',
    type: 'error'
  },
  {
    inputs: [],
    name: 'MessageFailed',
    type: 'error'
  },
  {
    inputs: [],
    name: 'MsgValueNotZero',
    type: 'error'
  },
  {
    inputs: [],
    name: 'NativeTokenIsEther',
    type: 'error'
  },
  {
    inputs: [],
    name: 'NewDepositCountExceedsMax',
    type: 'error'
  },
  {
    inputs: [],
    name: 'NoValueInMessagesOnGasTokenNetworks',
    type: 'error'
  },
  {
    inputs: [],
    name: 'NonZeroValueForUnusedFrontier',
    type: 'error'
  },
  {
    inputs: [],
    name: 'NotValidAmount',
    type: 'error'
  },
  {
    inputs: [],
    name: 'OnlyEmergencyState',
    type: 'error'
  },
  {
    inputs: [],
    name: 'OnlyNotEmergencyState',
    type: 'error'
  },
  {
    inputs: [],
    name: 'OnlyPendingProxiedTokensManager',
    type: 'error'
  },
  {
    inputs: [],
    name: 'OnlyProxiedTokensManager',
    type: 'error'
  },
  {
    inputs: [],
    name: 'OnlyRollupManager',
    type: 'error'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'token',
        type: 'address'
      }
    ],
    name: 'SafeERC20FailedOperation',
    type: 'error'
  },
  {
    inputs: [],
    name: 'SubtreeFrontierMismatch',
    type: 'error'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'oldProxiedTokensManager',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'newProxiedTokensManager',
        type: 'address'
      }
    ],
    name: 'AcceptProxiedTokensManagerRole',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint8',
        name: 'leafType',
        type: 'uint8'
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'originAddress',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'destinationNetwork',
        type: 'uint32'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256'
      },
      {
        indexed: false,
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes'
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'depositCount',
        type: 'uint32'
      }
    ],
    name: 'BridgeEvent',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint256',
        name: 'globalIndex',
        type: 'uint256'
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'originAddress',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256'
      }
    ],
    name: 'ClaimEvent',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [],
    name: 'EmergencyStateActivated',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [],
    name: 'EmergencyStateDeactivated',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint8',
        name: 'version',
        type: 'uint8'
      }
    ],
    name: 'Initialized',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'originTokenAddress',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'wrappedTokenAddress',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes'
      }
    ],
    name: 'NewWrappedToken',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'currentProxiedTokensManager',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'newProxiedTokensManager',
        type: 'address'
      }
    ],
    name: 'TransferProxiedTokensManagerRole',
    type: 'event'
  },
  {
    inputs: [],
    name: 'INIT_BYTECODE_TRANSPARENT_PROXY',
    outputs: [
      {
        internalType: 'bytes',
        name: '',
        type: 'bytes'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'WETHToken',
    outputs: [
      {
        internalType: 'contract ITokenWrappedBridgeUpgradeable',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'acceptProxiedTokensManagerRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'activateEmergencyState',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint32',
        name: 'destinationNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256'
      },
      {
        internalType: 'address',
        name: 'token',
        type: 'address'
      },
      {
        internalType: 'bool',
        name: 'forceUpdateGlobalExitRoot',
        type: 'bool'
      },
      {
        internalType: 'bytes',
        name: 'permitData',
        type: 'bytes'
      }
    ],
    name: 'bridgeAsset',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'bridgeLib',
    outputs: [
      {
        internalType: 'contract BridgeLib',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint32',
        name: 'destinationNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address'
      },
      {
        internalType: 'bool',
        name: 'forceUpdateGlobalExitRoot',
        type: 'bool'
      },
      {
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes'
      }
    ],
    name: 'bridgeMessage',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint32',
        name: 'destinationNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'amountWETH',
        type: 'uint256'
      },
      {
        internalType: 'bool',
        name: 'forceUpdateGlobalExitRoot',
        type: 'bool'
      },
      {
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes'
      }
    ],
    name: 'bridgeMessageWETH',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'bytes32[32]',
        name: 'smtProofLocalExitRoot',
        type: 'bytes32[32]'
      },
      {
        internalType: 'bytes32[32]',
        name: 'smtProofRollupExitRoot',
        type: 'bytes32[32]'
      },
      {
        internalType: 'uint256',
        name: 'globalIndex',
        type: 'uint256'
      },
      {
        internalType: 'bytes32',
        name: 'mainnetExitRoot',
        type: 'bytes32'
      },
      {
        internalType: 'bytes32',
        name: 'rollupExitRoot',
        type: 'bytes32'
      },
      {
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'originTokenAddress',
        type: 'address'
      },
      {
        internalType: 'uint32',
        name: 'destinationNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256'
      },
      {
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes'
      }
    ],
    name: 'claimAsset',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'bytes32[32]',
        name: 'smtProofLocalExitRoot',
        type: 'bytes32[32]'
      },
      {
        internalType: 'bytes32[32]',
        name: 'smtProofRollupExitRoot',
        type: 'bytes32[32]'
      },
      {
        internalType: 'uint256',
        name: 'globalIndex',
        type: 'uint256'
      },
      {
        internalType: 'bytes32',
        name: 'mainnetExitRoot',
        type: 'bytes32'
      },
      {
        internalType: 'bytes32',
        name: 'rollupExitRoot',
        type: 'bytes32'
      },
      {
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'originAddress',
        type: 'address'
      },
      {
        internalType: 'uint32',
        name: 'destinationNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256'
      },
      {
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes'
      }
    ],
    name: 'claimMessage',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256'
      }
    ],
    name: 'claimedBitMap',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'originTokenAddress',
        type: 'address'
      }
    ],
    name: 'computeTokenProxyAddress',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'deactivateEmergencyState',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'depositCount',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'gasTokenAddress',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'gasTokenMetadata',
    outputs: [
      {
        internalType: 'bytes',
        name: '',
        type: 'bytes'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'gasTokenNetwork',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'getProxiedTokensManager',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'getRoot',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'token',
        type: 'address'
      }
    ],
    name: 'getTokenMetadata',
    outputs: [
      {
        internalType: 'bytes',
        name: '',
        type: 'bytes'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'originTokenAddress',
        type: 'address'
      }
    ],
    name: 'getTokenWrappedAddress',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'getWrappedTokenBridgeImplementation',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'globalExitRootManager',
    outputs: [
      {
        internalType: 'contract IBaseLegacyAgglayerGER',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint32',
        name: '_networkID',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: '_gasTokenAddress',
        type: 'address'
      },
      {
        internalType: 'uint32',
        name: '_gasTokenNetwork',
        type: 'uint32'
      },
      {
        internalType: 'contract IBaseLegacyAgglayerGER',
        name: '_globalExitRootManager',
        type: 'address'
      },
      {
        internalType: 'address',
        name: '_polygonRollupManager',
        type: 'address'
      },
      {
        internalType: 'bytes',
        name: '_gasTokenMetadata',
        type: 'bytes'
      }
    ],
    name: 'initialize',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint32',
        name: 'leafIndex',
        type: 'uint32'
      },
      {
        internalType: 'uint32',
        name: 'sourceBridgeNetwork',
        type: 'uint32'
      }
    ],
    name: 'isClaimed',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'isEmergencyState',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'lastUpdatedDepositCount',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'networkID',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'pendingProxiedTokensManager',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'polygonRollupManager',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32'
      }
    ],
    name: 'tokenInfoToWrappedToken',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'newProxiedTokensManager',
        type: 'address'
      }
    ],
    name: 'transferProxiedTokensManagerRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'updateGlobalExitRoot',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'version',
    outputs: [
      {
        internalType: 'string',
        name: '',
        type: 'string'
      }
    ],
    stateMutability: 'pure',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    name: 'wrappedTokenToTokenInfo',
    outputs: [
      {
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32'
      },
      {
        internalType: 'address',
        name: 'originTokenAddress',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  }
] as const;
