import type { EncryptedFileForm, Navigate, GoBack, SetFormValues, Finish, EncryptedFileAction, UIForm } from './types';
// The runtime surface of this module is exactly two enums — `EncryptedFileStep`
// and `EncryptedFileActionId`. Everything else (`EncryptedFileForm`, the four
// action variants, the `EncryptedFileAction` union, and `UIForm`) is a
// compile-time-only type declaration that erases to nothing at runtime. Import
// the runtime members explicitly, and exercise the type-only shapes
// structurally so this file doubles as living documentation of the
// encrypted-file-flow contracts.
import { EncryptedFileStep, EncryptedFileActionId } from './types';
// Also grab the whole namespace so we can assert the module's runtime export
// set is exactly the two enums (no accidental runtime leakage).
import * as encryptedFileTypes from './types';

describe('encrypted-file-flow/types', () => {
  describe('module runtime surface', () => {
    it('exposes exactly the two enums at runtime', () => {
      expect(Object.keys(encryptedFileTypes).sort()).toEqual(['EncryptedFileActionId', 'EncryptedFileStep'].sort());
    });

    it('does not leak any of the type-only aliases at runtime', () => {
      const runtime = encryptedFileTypes as Record<string, unknown>;
      expect(runtime.EncryptedFileForm).toBeUndefined();
      expect(runtime.EncryptedFileAction).toBeUndefined();
      expect(runtime.UIForm).toBeUndefined();
      expect(runtime.Navigate).toBeUndefined();
      expect(runtime.GoBack).toBeUndefined();
      expect(runtime.SetFormValues).toBeUndefined();
      expect(runtime.Finish).toBeUndefined();
    });
  });

  describe('EncryptedFileStep enum', () => {
    it('maps every step key to its self-named string value', () => {
      expect(EncryptedFileStep.WalletPassword).toBe('WalletPassword');
      expect(EncryptedFileStep.ExportFilePassword).toBe('ExportFilePassword');
      expect(EncryptedFileStep.ExportFileComplete).toBe('ExportFileComplete');
      expect(EncryptedFileStep.Navigate).toBe('Navigate');
    });

    it('contains exactly the four known steps', () => {
      expect(Object.keys(EncryptedFileStep)).toEqual([
        'WalletPassword',
        'ExportFilePassword',
        'ExportFileComplete',
        'Navigate'
      ]);
      expect(Object.values(EncryptedFileStep)).toEqual([
        'WalletPassword',
        'ExportFilePassword',
        'ExportFileComplete',
        'Navigate'
      ]);
    });

    it('is a plain string enum with no reverse numeric mapping', () => {
      // String enums do not get TS's reverse (value→key) mapping that numeric
      // enums do, so the key set equals the value set in count.
      expect(Object.keys(EncryptedFileStep)).toHaveLength(4);
      expect(Object.values(EncryptedFileStep)).toHaveLength(4);
      expect((EncryptedFileStep as Record<string, unknown>).WalletPassword).toBe('WalletPassword');
    });
  });

  describe('EncryptedFileActionId enum', () => {
    it('maps every action id to its wire string', () => {
      expect(EncryptedFileActionId.GoBack).toBe('go-back');
      expect(EncryptedFileActionId.Navigate).toBe('navigate');
      expect(EncryptedFileActionId.SetFormValues).toBe('set-form-values');
      expect(EncryptedFileActionId.Finish).toBe('finish');
    });

    it('contains exactly the four known action ids', () => {
      expect(Object.keys(EncryptedFileActionId)).toEqual(['GoBack', 'Navigate', 'SetFormValues', 'Finish']);
      expect(Object.values(EncryptedFileActionId)).toEqual(['go-back', 'navigate', 'set-form-values', 'finish']);
    });
  });

  // --- Type-only shapes: structural round-trips. These do not add runtime
  // coverage (the type aliases erase), but they lock the contracts against
  // accidental field renames/removals via the TS compiler at test-build time.
  describe('type shape round-trips', () => {
    it('EncryptedFileForm carries the three required string fields', () => {
      const form: EncryptedFileForm = {
        walletPassword: 'hunter2',
        fileName: 'backup.mid',
        filePassword: 'file-secret'
      };

      expect(form).toEqual({
        walletPassword: 'hunter2',
        fileName: 'backup.mid',
        filePassword: 'file-secret'
      });
      expect(Object.keys(form).sort()).toEqual(['fileName', 'filePassword', 'walletPassword']);
      Object.values(form).forEach(v => expect(typeof v).toBe('string'));
    });

    it('UIForm accepts the full field set with optionals present and absent', () => {
      const complete: UIForm = {
        walletPassword: 'wp',
        fileName: 'export.mid',
        filePassword: 'fp'
      };
      const sparse: UIForm = {
        fileName: 'export.mid'
      };

      expect(complete.walletPassword).toBe('wp');
      expect(complete.filePassword).toBe('fp');
      expect(sparse.walletPassword).toBeUndefined();
      expect(sparse.filePassword).toBeUndefined();
      // `fileName` is the only required member.
      expect(sparse.fileName).toBe('export.mid');
    });

    it('EncryptedFileAction discriminated union covers every action id', () => {
      const navigate: Navigate = {
        id: EncryptedFileActionId.Navigate,
        step: EncryptedFileStep.ExportFilePassword
      };
      const goBack: GoBack = { id: EncryptedFileActionId.GoBack };
      const setValues: SetFormValues = {
        id: EncryptedFileActionId.SetFormValues,
        payload: { fileName: 'renamed.mid' },
        triggerValidation: true
      };
      const setValuesNoValidation: SetFormValues = {
        id: EncryptedFileActionId.SetFormValues,
        payload: {}
      };
      const finish: Finish = { id: EncryptedFileActionId.Finish };

      const actions: EncryptedFileAction[] = [navigate, goBack, setValues, setValuesNoValidation, finish];

      // Narrow each variant by its discriminant to prove the union is exhaustive.
      const results = actions.map(action => {
        switch (action.id) {
          case EncryptedFileActionId.Navigate:
            return action.step;
          case EncryptedFileActionId.GoBack:
            return action.id;
          case EncryptedFileActionId.SetFormValues:
            return action.payload;
          case EncryptedFileActionId.Finish:
            return action.id;
          default: {
            // Exhaustiveness guard: unreachable if the union is fully handled.
            const never: never = action;
            return never;
          }
        }
      });

      expect(results).toHaveLength(5);
      expect(navigate.step).toBe(EncryptedFileStep.ExportFilePassword);
      expect(goBack.id).toBe(EncryptedFileActionId.GoBack);
      expect(finish.id).toBe(EncryptedFileActionId.Finish);
      expect(setValues.triggerValidation).toBe(true);
      expect(setValuesNoValidation.triggerValidation).toBeUndefined();
    });

    it('SetFormValues payload accepts a partial UIForm', () => {
      // `payload: Partial<UIForm>` — every field is optional, including the
      // otherwise-required `fileName`, so an empty payload is valid.
      const onlyWalletPassword: SetFormValues = {
        id: EncryptedFileActionId.SetFormValues,
        payload: { walletPassword: 'wp' }
      };
      const onlyFileName: SetFormValues = {
        id: EncryptedFileActionId.SetFormValues,
        payload: { fileName: 'a.mid' }
      };
      const onlyFilePassword: SetFormValues = {
        id: EncryptedFileActionId.SetFormValues,
        payload: { filePassword: 'fp' }
      };

      expect(onlyWalletPassword.payload).toEqual({ walletPassword: 'wp' });
      expect(onlyFileName.payload).toEqual({ fileName: 'a.mid' });
      expect(onlyFilePassword.payload).toEqual({ filePassword: 'fp' });
    });
  });
});
