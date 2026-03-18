import React, { ComponentProps, forwardRef, useCallback, useEffect, useMemo, useState } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';

const AssetExtraInner = (
  assetSymbol: string,
  showMax: boolean,
  setMax: (evt: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void,
  t: (key: string) => string
) => {
  return (
    <div
      className={classNames('overflow-hidden', 'absolute inset-y-0 right-0 w-40', 'flex items-center justify-end')}
      style={{ fontSize: '14px', lineHeight: '20px' }}
    >
      <span className="mr-2 font-medium text-black cursor-pointer">{assetSymbol}</span>
      {showMax && (
        <button
          className="mr-2 font-medium text-black bg-gray-800 hover:bg-gray-300 active:bg-gray-100 py-2 px-2 rounded-lg cursor-pointer"
          style={{ width: '50px' }}
          onClick={setMax}
        >
          {t('max')}
        </button>
      )}
    </div>
  );
};

type AssetFieldProps = Omit<ComponentProps<typeof FormField>, 'onChange'> & {
  value?: number | string;
  min?: number;
  max?: number;
  showMax?: boolean;
  assetSymbol?: string;
  assetDecimals?: number;
  onChange?: (v?: string) => void;
};

const AssetField = forwardRef<HTMLInputElement, AssetFieldProps>(
  (
    {
      value,
      min = 0,
      max = Number.MAX_SAFE_INTEGER,
      showMax = true,
      assetSymbol,
      assetDecimals = 6,
      onChange,
      onFocus,
      onBlur,
      ...rest
    },
    ref
  ) => {
    const { t } = useTranslation();
    const valueStr = useMemo(() => (value === undefined ? '' : new BigNumber(value).toFixed()), [value]);

    const [localValue, setLocalValue] = useState(valueStr);
    const [focused, setFocused] = useState(false);

    useEffect(() => {
      if (!focused) {
        setLocalValue(valueStr);
      }
    }, [setLocalValue, focused, valueStr]);

    const handleChange = useCallback(
      (evt: React.ChangeEvent<HTMLInputElement> & React.ChangeEvent<HTMLTextAreaElement>) => {
        let val = evt.target.value.replace(/ /g, '').replace(/,/g, '.');
        let numVal = new BigNumber(val || 0);
        const indexOfDot = val.indexOf('.');
        if (indexOfDot !== -1 && val.length - indexOfDot > assetDecimals + 1) {
          val = val.substring(0, indexOfDot + assetDecimals + 1);
          numVal = new BigNumber(val);
        }
        if (val === '.') {
          val = '0.';
          numVal = new BigNumber(val);
        }

        if (!numVal.isNaN() && numVal.isGreaterThanOrEqualTo(min) && numVal.isLessThanOrEqualTo(max)) {
          setLocalValue(val);
          if (onChange) {
            onChange(val !== '' ? numVal.toFixed() : undefined);
          }
        }
      },
      [assetDecimals, setLocalValue, min, max, onChange]
    );

    const setMax = useCallback(
      (evt: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
        evt.preventDefault();
        const maxString = max.toFixed(assetDecimals);
        setLocalValue(maxString);
        if (onChange) onChange(maxString);
      },
      [max, onChange, assetDecimals]
    );

    const handleFocus = useCallback(
      (evt: React.FocusEvent<HTMLInputElement> & React.FocusEvent<HTMLTextAreaElement>) => {
        setFocused(true);
        if (onFocus) {
          onFocus(evt);
          if (evt.defaultPrevented) {
            return;
          }
        }
      },
      [setFocused, onFocus]
    );

    const handleBlur = useCallback(
      (evt: React.FocusEvent<HTMLInputElement> & React.FocusEvent<HTMLTextAreaElement>) => {
        setFocused(false);
        if (onBlur) {
          onBlur(evt);
          if (evt.defaultPrevented) {
            return;
          }
        }
      },
      [setFocused, onBlur]
    );

    return (
      <FormField
        ref={ref}
        type="text"
        value={localValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        extraInner={AssetExtraInner(assetSymbol!, showMax, setMax, t)}
        useDefaultInnerWrapper={false}
        {...rest}
      />
    );
  }
);

export default AssetField;
