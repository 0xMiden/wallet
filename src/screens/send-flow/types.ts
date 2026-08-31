import type { AddressChain } from 'utils/miden';

import { BridgeNetworkId } from './bridge-networks';

/** Cross-chain route. Fast = Epoch (any token → USDC, fee), Slow = Agglayer (bridgeable token only, no fee). */
export type BridgeRoute = 'epoch' | 'agglayer';

export enum SendFlowStep {
  SelectRecipient = 'SelectRecipient',
  SelectAmount = 'SelectAmount',
  /** Cross-chain only: pick Fast (Epoch) vs Slow (Agglayer) before handing off to /send/review. */
  Route = 'Route'
}

export type SendFlowForm = {
  amount: string;
  recipientAddress: string;
  token?: UIToken;
  /** Destination network, only meaningful when the recipient is a 0x (Ethereum) address. */
  bridgeNetwork?: BridgeNetworkId;
  /** Cross-chain route, only meaningful when the recipient is a 0x (Ethereum) address. */
  bridgeRoute?: BridgeRoute;
};

export enum SendFlowActionId {
  GoBack = 'go-back',
  Navigate = 'navigate',
  SetFormValues = 'set-form-values',
  Finish = 'finish'
}

export type Navigate = {
  id: SendFlowActionId.Navigate;
  step: SendFlowStep;
};

export type GoBack = {
  id: SendFlowActionId.GoBack;
};

export type SetFormValues = {
  id: SendFlowActionId.SetFormValues;
  payload: Partial<SendFlowForm>;
  triggerValidation?: boolean;
};

export type Finish = {
  id: SendFlowActionId.Finish;
};

export type SendFlowAction = Navigate | GoBack | SetFormValues | Finish;

export type Contact = {
  id: string;
  name: string;
  isOwned: boolean;
  contactType: 'public' | 'private' | 'external';
  isGuardian?: boolean;
};

/**
 * A previously used send recipient, derived from the local transaction history.
 * Deduped by address and resolved against the contact list for a display name.
 */
export type RecentRecipient = {
  /** Address the send went to (`secondaryAccountId` on the stored `send` row). */
  address: string;
  /** Matching saved contact / wallet account name, when the address is known. */
  name?: string;
  /** Chain the address belongs to, from `detectAddressChain`. */
  chain: AddressChain;
  /** Destination network display name for a cross-chain (0x) recipient. */
  networkName?: string;
};

export enum UIFeeType {
  Public = 'public',
  Private = 'private'
}
export type UIToken = {
  id: string;
  name: string;
  decimals: number;
  balance: number;
  fiatPrice: number;
  /**
   * Whether `decimals` is what the faucet reported, rather than the unknown-token
   * placeholder's guess of 6.
   *
   * Required, not optional, because the amount the user types is converted to
   * base units with `decimals` — an omitted field would default to "trustworthy"
   * and send a quantity nobody chose. Every producer has to answer for its own
   * source: the registry and the fixed EVM tokens state their decimals, a wallet
   * balance has to be asked via `hasKnownScale`.
   */
  scaleIsKnown: boolean;
};

export type UIContact = {
  id: string;
  name: string;
  address: string;
  isOwned: boolean;
};

export enum UITransactionType {
  Public = 'public',
  Private = 'private'
}

export type UIForm = {
  amount: string;
  sendType: UITransactionType;
  sharePrivately: boolean;
  receiveType: UITransactionType;
  recallBlocks?: string;
  recipientAddress?: string;
  recipientAddressInput?: string;
  recipientAnsName?: string;
  token?: UIToken;
  feeAmount: string;
  feeType: UIFeeType;
};

export const TransactionTypeNameMapping: Record<UITransactionType, string> = {
  [UITransactionType.Public]: 'Public',
  [UITransactionType.Private]: 'Private'
};

export type UIBalance = {
  public: number;
  private: number;
};

export type UIRecords = {
  public: number;
  private: number;
};

export type UIFees = {
  MIDEN: {
    [UITransactionType.Public]: {
      [UITransactionType.Public]: string;
      [UITransactionType.Private]: string;
    };
    [UITransactionType.Private]: {
      [UITransactionType.Public]: string;
      [UITransactionType.Private]: string;
    };
  };
  OTHER: {
    [UITransactionType.Public]: {
      [UITransactionType.Public]: string;
      [UITransactionType.Private]: string;
    };
    [UITransactionType.Private]: {
      [UITransactionType.Public]: string;
      [UITransactionType.Private]: string;
    };
  };
};
