import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { TextField } from 'components/ui/TextField';
import {
  isValidTokenDecimals,
  isValidTokenName,
  isValidTokenSymbol,
  TOKEN_DECIMALS_MAX,
  TOKEN_NAME_MAX_LENGTH,
  TOKEN_SYMBOL_MAX_LENGTH,
  TokenMetadataOverride
} from 'lib/miden/metadata/overrides';
import { hapticMedium } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

/** The values the token page shows now: the faucet's, with any override applied. */
export type TokenDetailsValues = {
  name: string;
  symbol: string;
  /** The decimals the user set. Empty for an unknown scale, so the user must state it. */
  decimals: string;
};

/** The fields that are not valid. */
type FieldErrors = Partial<Record<keyof TokenDetailsValues, true>>;

type Validation = { override: TokenMetadataOverride; errors?: never } | { override?: never; errors: FieldErrors };

const DECIMALS_PATTERN = /^\d+$/;

/**
 * Trims the values and upper-cases the symbol. Returns the override, or the fields that are not valid.
 * Without `withDecimals` the override has no decimals, so a save drops any stored before.
 */
function validate(values: TokenDetailsValues, withDecimals: boolean): Validation {
  const name = values.name.trim();
  const symbol = values.symbol.trim().toUpperCase();
  const decimalsText = values.decimals.trim();
  const decimals = DECIMALS_PATTERN.test(decimalsText) ? Number(decimalsText) : NaN;

  const errors: FieldErrors = {};
  if (!isValidTokenName(name)) errors.name = true;
  if (!isValidTokenSymbol(symbol)) errors.symbol = true;
  if (withDecimals && !isValidTokenDecimals(decimals)) errors.decimals = true;

  if (Object.keys(errors).length > 0) return { errors };
  return { override: withDecimals ? { name, symbol, decimals } : { name, symbol } };
}

type SheetBodyProps = {
  faucetId: string;
  initialValues: TokenDetailsValues;
  decimalsEditable: boolean;
  edited: boolean;
  onDone: () => void;
  /** Reported upward so the sheet cannot close while a write is in flight. */
  onBusyChange: (busy: boolean) => void;
};

const SheetBody: FC<SheetBodyProps> = ({ faucetId, initialValues, decimalsEditable, edited, onDone, onBusyChange }) => {
  const { t } = useTranslation();
  const setTokenMetadataOverride = useWalletStore(s => s.setTokenMetadataOverride);
  const clearTokenMetadataOverride = useWalletStore(s => s.clearTokenMetadataOverride);
  const [values, setValues] = useState<TokenDetailsValues>(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const changeField = (field: keyof TokenDetailsValues, value: string) => {
    setValues(previous => ({ ...previous, [field]: value }));
    setErrors(previous => ({ ...previous, [field]: undefined }));
    setSaveFailed(false);
  };

  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    onBusyChange(true);
    setSaveFailed(false);
    try {
      await write();
      // Lower the flag before the close. The flag lives in the parent, which outlives this body.
      onBusyChange(false);
      onDone();
    } catch (error) {
      console.warn('Token details save failed', error);
      setSaveFailed(true);
      setBusy(false);
      onBusyChange(false);
    }
  };

  const save = () => {
    if (busy) return;
    const result = validate(values, decimalsEditable);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    run(() => setTokenMetadataOverride(faucetId, result.override));
  };

  const reset = () => {
    if (busy) return;
    hapticMedium();
    run(() => clearTokenMetadataOverride(faucetId));
  };

  return (
    <form
      className="flex flex-col gap-5 px-4 pb-4"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
    >
      <TextField
        label={t('tokenNameLabel')}
        value={values.name}
        onChange={event => changeField('name', event.target.value)}
        error={errors.name && t('tokenNameInvalid', { max: TOKEN_NAME_MAX_LENGTH })}
        errorTestId="edit-token-name-error"
        maxLength={TOKEN_NAME_MAX_LENGTH}
        autoCorrect="off"
        enterKeyHint="next"
        data-testid="edit-token-name"
      />
      <TextField
        label={t('tokenSymbolLabel')}
        value={values.symbol}
        onChange={event => changeField('symbol', event.target.value)}
        error={errors.symbol && t('tokenSymbolInvalid', { max: TOKEN_SYMBOL_MAX_LENGTH })}
        errorTestId="edit-token-symbol-error"
        maxLength={TOKEN_SYMBOL_MAX_LENGTH}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint={decimalsEditable ? 'next' : 'done'}
        data-testid="edit-token-symbol"
      />
      {decimalsEditable && (
        <>
          <TextField
            label={t('tokenDecimalsLabel')}
            value={values.decimals}
            onChange={event => changeField('decimals', event.target.value)}
            error={errors.decimals && t('tokenDecimalsInvalid', { max: TOKEN_DECIMALS_MAX })}
            errorTestId="edit-token-decimals-error"
            inputMode="numeric"
            maxLength={2}
            enterKeyHint="done"
            data-testid="edit-token-decimals"
          />

          <Notice variant="inline" data-testid="edit-token-notice">
            {t('tokenMetadataOverrideNotice')}
          </Notice>
        </>
      )}

      {saveFailed && <ErrorLine data-testid="edit-token-save-error">{t('tokenMetadataSaveError')}</ErrorLine>}

      <div className="flex flex-col gap-2.5">
        <Button
          type="submit"
          title={t('saveTokenDetails')}
          variant={ButtonVariant.Primary}
          disabled={busy}
          isLoading={busy}
          data-testid="edit-token-save"
          className="w-full max-w-none"
        />
        {edited && (
          <Button
            title={t('resetToFaucetValues')}
            variant={ButtonVariant.Secondary}
            disabled={busy}
            onClick={reset}
            data-testid="edit-token-reset"
            className="w-full max-w-none"
          />
        )}
      </div>
    </form>
  );
};

type EditTokenDetailsDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  faucetId: string;
  initialValues: TokenDetailsValues;
  /** The faucet's scale is unknown, so the decimals are the user's to set. */
  decimalsEditable: boolean;
  /** The user has set values for this token, so the sheet offers the reset. */
  edited: boolean;
  /** The host changes it on each opening, so the form starts from the values on the page, not from an earlier draft. */
  sessionKey: number;
};

/**
 * The sheet where the user sets the name and symbol this wallet shows for a token, and its decimals
 * while the faucet's scale is unknown.
 * The values are the user's own. The faucet keeps its values, and the reset shows them again.
 * Mobile back closes the sheet through the shared `Drawer`, before the page's own back.
 */
export const EditTokenDetailsDrawer: FC<EditTokenDetailsDrawerProps> = ({
  open,
  onOpenChange,
  faucetId,
  initialValues,
  decimalsEditable,
  edited,
  sessionKey
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  return (
    <Drawer
      open={open}
      screenKey="edit-token-details"
      onOpenChange={next => {
        // A swipe, a tap outside, Escape or mobile back during a write would hide its result.
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DrawerContent data-testid="edit-token-details-sheet">
        <DrawerHeader>
          <DrawerTitle>{t('editTokenDetailsTitle')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-col overflow-y-auto no-scrollbar">
          <SheetBody
            key={sessionKey}
            faucetId={faucetId}
            initialValues={initialValues}
            decimalsEditable={decimalsEditable}
            edited={edited}
            onDone={() => onOpenChange(false)}
            onBusyChange={setBusy}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
};
