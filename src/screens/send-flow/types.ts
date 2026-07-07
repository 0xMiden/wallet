export enum SendFlowStep {
  SelectRecipient = 'SelectRecipient',
  SelectAmount = 'SelectAmount',
  TransactionInitiated = 'TransactionInitiated'
}

export type SendFlowForm = {
  amount: string;
  recipientAddress: string;
  token?: UIToken;
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
  ALEO: {
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
