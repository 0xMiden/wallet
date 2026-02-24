import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as LockAltIcon } from '../icons/lock-alt.svg';

interface SeedWordInputProps {
  id: number;
  submitted: boolean;
  showSeed: boolean;
  isFirstAccount?: boolean;
  value?: string;
  autoComplete?: string;
  setShowSeed: (value: boolean) => void;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  className?: string;
}

export const SeedWordInput: FC<SeedWordInputProps> = ({
  id,
  submitted,
  showSeed,
  value,
  isFirstAccount,
  autoComplete = 'off',
  setShowSeed,
  onChange,
  onPaste,
  className
}) => {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isError = submitted ? !value : false;
  const isWordHidden = useMemo(() => {
    if (focused || !value) {
      return false;
    }

    return !showSeed;
  }, [focused, showSeed, value]);

  useEffect(() => {
    if (showSeed) {
      const handleLocalBlur = () => {
        inputRef.current?.blur();
        setShowSeed(false);
      };
      const t = setTimeout(() => {
        handleLocalBlur();
      }, 30_000);
      window.addEventListener('blur', handleLocalBlur);
      return () => {
        clearTimeout(t);
        window.removeEventListener('blur', handleLocalBlur);
      };
    }
    return undefined;
  }, [showSeed, inputRef, setShowSeed]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (onChange) {
        onChange(e);
      }
    },
    [onChange]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      if (onPaste) {
        inputRef.current?.blur();
        onPaste(e);
      }
    },
    [onPaste]
  );

  return (
    <div className={classNames('relative', 'flex flex-col items-center', 'w-44')}>
      <label
        htmlFor={id.toString()}
        className={`w-full justify-start font-medium ${isError ? 'text-red-600' : 'text-black'}`}
      >
        <p style={{ fontSize: 14 }}>{`#${id + 1}`}</p>
      </label>
      <input
        ref={inputRef}
        id={id.toString()}
        value={value}
        autoComplete={autoComplete}
        onChange={handleChange}
        onPaste={handlePaste}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setShowSeed(false);
        }}
        className={classNames(
          'appearance-none',
          'w-full py-3 border-2',
          isError ? 'border-red-500' : 'border-gray-100',
          'rounded-lg',
          'focus:border-primary-orange',
          'bg-white focus:bg-transparent',
          'focus:outline-none focus:shadow-outline',
          'transition ease-in-out duration-200',
          'text-black text-lg leading-tight',
          'placeholder-alphagray',
          'text-center',
          className
        )}
      />
      {isWordHidden && (
        <div
          className={classNames(
            'absolute',
            'w-full',
            'cursor-pointer flex items-center justify-center',
            'bg-gray-800/80 rounded-lg'
          )}
          style={{ top: 20, height: 52 }}
          onClick={() => {
            inputRef.current?.focus();
            setShowSeed(true);
          }}
        >
          <p className={classNames('flex items-center', 'text-gray-500 text-sm')}>
            <LockAltIcon className={classNames('mr-1', 'h-6 w-auto', 'stroke-current stroke-2')} />
            <span>{t('clickToReveal')}</span>
          </p>
        </div>
      )}
    </div>
  );
};
