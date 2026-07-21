import type {
  SendFlowForm,
  Navigate,
  GoBack,
  SetFormValues,
  Finish,
  SendFlowAction,
  Contact,
  UIToken,
  UIContact,
  UIForm,
  UIBalance,
  UIRecords,
  UIFees
} from './types';
// The runtime surface of this module is the four enums plus the
// `TransactionTypeNameMapping` const; everything else is compile-time-only
// type declaration that erases to nothing. Import the runtime members
// explicitly, and exercise the type-only shapes structurally so this file
// doubles as living documentation of the send-flow contracts.
import { SendFlowStep, SendFlowActionId, UIFeeType, UITransactionType, TransactionTypeNameMapping } from './types';
// Also grab the whole namespace so we can assert the module's runtime export
// set is exactly the enums + mapping (no accidental runtime leakage).
import * as sendFlowTypes from './types';

describe('send-flow/types', () => {
  describe('module runtime surface', () => {
    it('exposes exactly the enums and the mapping at runtime', () => {
      expect(Object.keys(sendFlowTypes).sort()).toEqual(
        ['SendFlowActionId', 'SendFlowStep', 'TransactionTypeNameMapping', 'UIFeeType', 'UITransactionType'].sort()
      );
    });
  });

  describe('SendFlowStep enum', () => {
    it('maps every step key to its self-named string value', () => {
      expect(SendFlowStep.SelectRecipient).toBe('SelectRecipient');
      expect(SendFlowStep.SelectAmount).toBe('SelectAmount');
      expect(SendFlowStep.TransactionInitiated).toBe('TransactionInitiated');
    });

    it('contains exactly three steps', () => {
      expect(Object.keys(SendFlowStep)).toEqual(['SelectRecipient', 'SelectAmount', 'TransactionInitiated']);
      expect(Object.values(SendFlowStep)).toEqual(['SelectRecipient', 'SelectAmount', 'TransactionInitiated']);
    });
  });

  describe('SendFlowActionId enum', () => {
    it('maps every action id to its wire string', () => {
      expect(SendFlowActionId.GoBack).toBe('go-back');
      expect(SendFlowActionId.Navigate).toBe('navigate');
      expect(SendFlowActionId.SetFormValues).toBe('set-form-values');
      expect(SendFlowActionId.Finish).toBe('finish');
    });

    it('contains exactly the four known action ids', () => {
      expect(Object.values(SendFlowActionId)).toEqual(['go-back', 'navigate', 'set-form-values', 'finish']);
    });
  });

  describe('UIFeeType enum', () => {
    it('maps public/private to lowercase strings', () => {
      expect(UIFeeType.Public).toBe('public');
      expect(UIFeeType.Private).toBe('private');
    });

    it('contains exactly two fee types', () => {
      expect(Object.values(UIFeeType)).toEqual(['public', 'private']);
    });
  });

  describe('UITransactionType enum', () => {
    it('maps public/private to lowercase strings', () => {
      expect(UITransactionType.Public).toBe('public');
      expect(UITransactionType.Private).toBe('private');
    });

    it('contains exactly two transaction types', () => {
      expect(Object.values(UITransactionType)).toEqual(['public', 'private']);
    });
  });

  describe('TransactionTypeNameMapping', () => {
    it('maps each UITransactionType to its human-readable label', () => {
      expect(TransactionTypeNameMapping[UITransactionType.Public]).toBe('Public');
      expect(TransactionTypeNameMapping[UITransactionType.Private]).toBe('Private');
    });

    it('has an entry for every UITransactionType value', () => {
      const mappedKeys = Object.keys(TransactionTypeNameMapping).sort();
      const enumValues = Object.values(UITransactionType).sort();
      expect(mappedKeys).toEqual(enumValues);
    });

    it('is keyed by enum value, not enum key', () => {
      // Ensures the record is indexed on 'public'/'private', not 'Public'/'Private'.
      expect(TransactionTypeNameMapping).toEqual({
        public: 'Public',
        private: 'Private'
      });
    });
  });

  // --- Type-only shapes: structural round-trips. These do not add runtime
  // coverage (the type aliases erase), but they lock the contracts against
  // accidental field renames/removals via the TS compiler at test-build time.
  describe('type shape round-trips', () => {
    it('SendFlowForm accepts the full and minimal shapes', () => {
      const full: SendFlowForm = {
        amount: '12.5',
        recipientAddress: '0xrecipient',
        token: {
          id: 'tok',
          name: 'Token',
          decimals: 6,
          balance: 100,
          fiatPrice: 1.23
        }
      };
      const minimal: SendFlowForm = {
        amount: '',
        recipientAddress: ''
      };
      expect(full.token?.decimals).toBe(6);
      expect(minimal.token).toBeUndefined();
    });

    it('SendFlowAction discriminated union covers every action id', () => {
      const navigate: Navigate = {
        id: SendFlowActionId.Navigate,
        step: SendFlowStep.SelectAmount
      };
      const goBack: GoBack = { id: SendFlowActionId.GoBack };
      const setValues: SetFormValues = {
        id: SendFlowActionId.SetFormValues,
        payload: { amount: '5' },
        triggerValidation: true
      };
      const setValuesNoValidation: SetFormValues = {
        id: SendFlowActionId.SetFormValues,
        payload: {}
      };
      const finish: Finish = { id: SendFlowActionId.Finish };

      const actions: SendFlowAction[] = [navigate, goBack, setValues, setValuesNoValidation, finish];

      // Narrow each variant by its discriminant to prove the union is exhaustive.
      const ids = actions.map(action => {
        switch (action.id) {
          case SendFlowActionId.Navigate:
            return action.step;
          case SendFlowActionId.GoBack:
            return action.id;
          case SendFlowActionId.SetFormValues:
            return action.payload;
          case SendFlowActionId.Finish:
            return action.id;
          default: {
            // Exhaustiveness guard: unreachable if the union is fully handled.
            const never: never = action;
            return never;
          }
        }
      });

      expect(ids).toHaveLength(5);
      expect(setValues.triggerValidation).toBe(true);
      expect(setValuesNoValidation.triggerValidation).toBeUndefined();
    });

    it('Contact accepts each contactType and optional guardian flag', () => {
      const publicContact: Contact = {
        id: '1',
        name: 'Alice',
        isOwned: true,
        contactType: 'public'
      };
      const privateContact: Contact = {
        id: '2',
        name: 'Bob',
        isOwned: false,
        contactType: 'private',
        isGuardian: true
      };
      const externalContact: Contact = {
        id: '3',
        name: 'Carol',
        isOwned: false,
        contactType: 'external'
      };

      const types = [publicContact, privateContact, externalContact].map(c => c.contactType);
      expect(types).toEqual(['public', 'private', 'external']);
      expect(privateContact.isGuardian).toBe(true);
      expect(publicContact.isGuardian).toBeUndefined();
    });

    it('UIToken carries id/name/decimals/balance/fiatPrice', () => {
      const token: UIToken = {
        id: 'aleo',
        name: 'Aleo Credits',
        decimals: 6,
        balance: 42,
        fiatPrice: 0.5
      };
      expect(token).toMatchObject({ id: 'aleo', decimals: 6, fiatPrice: 0.5 });
    });

    it('UIContact carries address alongside identity fields', () => {
      const contact: UIContact = {
        id: 'c1',
        name: 'Dave',
        address: '0xdave',
        isOwned: false
      };
      expect(contact.address).toBe('0xdave');
    });

    it('UIForm accepts the full field set with optionals present and absent', () => {
      const complete: UIForm = {
        amount: '10',
        sendType: UITransactionType.Public,
        sharePrivately: true,
        receiveType: UITransactionType.Private,
        recallBlocks: '100',
        recipientAddress: '0xdst',
        recipientAddressInput: 'dst.aleo',
        recipientAnsName: 'dst.aleo',
        token: {
          id: 'aleo',
          name: 'Aleo',
          decimals: 6,
          balance: 1,
          fiatPrice: 1
        },
        feeAmount: '0.01',
        feeType: UIFeeType.Public
      };
      const sparse: UIForm = {
        amount: '0',
        sendType: UITransactionType.Private,
        sharePrivately: false,
        receiveType: UITransactionType.Public,
        feeAmount: '0',
        feeType: UIFeeType.Private
      };
      expect(complete.recallBlocks).toBe('100');
      expect(sparse.recipientAddress).toBeUndefined();
      expect(sparse.token).toBeUndefined();
    });

    it('UIBalance and UIRecords track public/private numbers', () => {
      const balance: UIBalance = { public: 3, private: 7 };
      const records: UIRecords = { public: 1, private: 2 };
      expect(balance.public + balance.private).toBe(10);
      expect(records.public + records.private).toBe(3);
    });

    it('UIFees nests ALEO/OTHER by send→receive transaction type', () => {
      const fees: UIFees = {
        ALEO: {
          [UITransactionType.Public]: {
            [UITransactionType.Public]: '1',
            [UITransactionType.Private]: '2'
          },
          [UITransactionType.Private]: {
            [UITransactionType.Public]: '3',
            [UITransactionType.Private]: '4'
          }
        },
        OTHER: {
          [UITransactionType.Public]: {
            [UITransactionType.Public]: '5',
            [UITransactionType.Private]: '6'
          },
          [UITransactionType.Private]: {
            [UITransactionType.Public]: '7',
            [UITransactionType.Private]: '8'
          }
        }
      };

      expect(fees.ALEO[UITransactionType.Public][UITransactionType.Private]).toBe('2');
      expect(fees.OTHER[UITransactionType.Private][UITransactionType.Public]).toBe('7');
    });
  });
});
