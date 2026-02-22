import React, {
  forwardRef,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import CleanButton from 'app/atoms/CleanButton';
import CopyButton from 'app/atoms/CopyButton';
import { ReactComponent as CopyIcon } from 'app/icons/copy.svg';
import { ReactComponent as EyeClosedIcon } from 'app/icons/eye-closed-bold.svg';
import { blurHandler, checkedHandler, focusHandler } from 'lib/ui/inputHandlers';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';

import usePasswordToggle from './usePasswordToggle.hook';

export const PASSWORD_ERROR_CAPTION = 'PASSWORD_ERROR_CAPTION';

type FormFieldRef = HTMLInputElement | HTMLTextAreaElement;
type FormFieldAttrs = InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>;
interface FormFieldProps extends FormFieldAttrs {
  extraSection?: ReactNode;
  label?: ReactNode;
  labelDescription?: ReactNode;
  labelWarning?: ReactNode;
  errorCaption?: ReactNode;
  containerClassName?: string;
  containerStyle?: React.CSSProperties;
  textarea?: boolean;
  secret?: boolean;
  cleanable?: boolean;
  extraButton?: ReactNode;
  extraInner?: ReactNode;
  useDefaultInnerWrapper?: boolean;
  onClean?: () => void;
  fieldWrapperBottomMargin?: boolean;
  labelPaddingClassName?: string;
  dropdownInner?: ReactNode;
  copyable?: boolean;
  labelClassName?: string;
  labelDiscriptionClassName?: string;
}

const FormField = forwardRef<FormFieldRef, FormFieldProps>(
  (
    {
      containerStyle,
      extraSection,
      label,
      labelDescription,
      labelWarning,
      errorCaption,
      containerClassName,
      textarea,
      secret: secretProp,
      cleanable,
      extraButton = null,
      extraInner = null,
      dropdownInner = null,
      useDefaultInnerWrapper = true,
      id,
      type,
      value,
      defaultValue,
      onChange,
      onFocus,
      onBlur,
      onClean,
      className,
      spellCheck = false,
      autoComplete = 'off',
      fieldWrapperBottomMargin = true,
      labelPaddingClassName = '',
      copyable,
      labelClassName,
      labelDiscriptionClassName,
      ...rest
    },
    ref
  ) => {
    const secret = secretProp && textarea;
    const Field = textarea ? 'textarea' : 'input';

    const [passwordInputType, TogglePasswordIcon] = usePasswordToggle();
    const isPasswordInput = type === 'password';
    const inputType = isPasswordInput ? passwordInputType : type;

    const { copy } = useCopyToClipboard();

    const [localValue, setLocalValue] = useState(value ?? defaultValue ?? '');
    const [focused, setFocused] = useState(false);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>) => {
        checkedHandler(e, onChange!, setLocalValue);
      },
      [onChange, setLocalValue]
    );

    const handleFocus = useCallback(
      (e: React.FocusEvent<HTMLInputElement> | React.FocusEvent<HTMLTextAreaElement>) =>
        focusHandler(e, onFocus!, setFocused),
      [onFocus, setFocused]
    );
    const handleBlur = useCallback(
      (e: React.FocusEvent<HTMLInputElement> | React.FocusEvent<HTMLTextAreaElement>) =>
        blurHandler(e, onBlur!, setFocused),
      [onBlur, setFocused]
    );

    const getFieldEl = useCallback(() => {
      const selector = 'input, textarea';
      return rootRef.current?.querySelector<HTMLFormElement>(selector);
    }, []);

    useEffect(() => {
      if (secret && focused) {
        const handleLocalBlur = () => {
          getFieldEl()?.blur();
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
    }, [secret, focused, getFieldEl]);

    const secretBannerDisplayed = useMemo(
      () => Boolean(secret && localValue !== '' && !focused),
      [secret, localValue, focused]
    );

    const rootRef = useRef<HTMLDivElement>(null);

    const handleSecretBannerClick = useCallback(() => {
      getFieldEl()?.focus();
    }, [getFieldEl]);

    const handleCleanClick = useCallback(() => {
      if (onClean) {
        onClean();
      }
    }, [onClean]);

    return (
      <div ref={rootRef} className={classNames('w-full flex flex-col', containerClassName)} style={containerStyle}>
        <LabelComponent
          label={label}
          warning={labelWarning}
          description={labelDescription}
          className={classNames(labelPaddingClassName, labelClassName)}
          id={id}
          descriptionClassName={labelDiscriptionClassName}
        />

        {extraSection}

        <div className={classNames('relative', fieldWrapperBottomMargin && 'mb-2', 'flex items-stretch')}>
          <Field
            ref={ref as any}
            className={classNames(
              'appearance-none',
              'rounded-lg',
              'w-full',
              'py-2 pl-4',
              getInnerClassName(isPasswordInput, extraInner),
              errorCaption ? 'border-red-500' : 'border-gray-100',
              secretBannerDisplayed ? 'border border-gray-600' : 'border',
              'bg-gray-25 focus:bg-transparent',
              'outline-none',
              'transition ease-in-out duration-200',
              'leading-tight',
              'placeholder:text-gray-600 placeholder:font-medium placeholder:text-sm',
              className
            )}
            style={{
              fontSize: '16px',
              lineHeight: '28px'
            }}
            id={id}
            type={inputType}
            value={value}
            defaultValue={defaultValue}
            spellCheck={spellCheck}
            autoComplete={autoComplete}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            {...rest}
          />

          {localValue !== '' && isPasswordInput && TogglePasswordIcon}
          <ExtraInner innerComponent={extraInner} useDefaultInnerWrapper={useDefaultInnerWrapper} />

          {dropdownInner}

          {extraButton}

          <SecretBanner
            handleSecretBannerClick={handleSecretBannerClick}
            secretBannerDisplayed={secretBannerDisplayed}
          />

          <Cleanable cleanable={cleanable} handleCleanClick={handleCleanClick} />
          <Copyable value={value} copy={copy} cleanable={cleanable} copyable={copyable} />
        </div>
        <ErrorCaption errorCaption={errorCaption} />
      </div>
    );
  }
);

interface ExtraInnerProps {
  innerComponent: React.ReactNode;
  useDefaultInnerWrapper: boolean;
}

const ExtraInner: React.FC<ExtraInnerProps> = ({ useDefaultInnerWrapper, innerComponent }) => {
  if (useDefaultInnerWrapper)
    return (
      <div
        className={classNames(
          'overflow-hidden',
          'absolute inset-y-0 right-0 w-32',
          'flex items-center justify-end',
          'pointer-events-none'
        )}
      >
        <span className="mx-4 text-xs font-medium text-black">{innerComponent}</span>
      </div>
    );
  return <>{innerComponent}</>;
};

interface SecretBannerProps {
  handleSecretBannerClick: () => void;
  secretBannerDisplayed: boolean;
}

const SecretBanner: React.FC<SecretBannerProps> = ({ secretBannerDisplayed, handleSecretBannerClick }) => {
  const { t } = useTranslation();

  if (!secretBannerDisplayed) return null;

  return (
    <div
      className={classNames('absolute', 'bg-gray-800 rounded-5', 'flex items-center justify-center', 'cursor-text')}
      style={{
        top: 2,
        right: 2,
        bottom: 2,
        left: 2
      }}
      onClick={handleSecretBannerClick}
    >
      <div className="rounded-lg">
        <EyeClosedIcon className={classNames('m-auto')} style={{ height: '20px', width: '20px' }} />
        <p className={classNames('mb-1', 'flex items-center', 'text-md font-semibold', 'uppercase')}></p>

        <p className={classNames('mb-1', 'flex items-center', 'text-sm')}>
          <span>{t('clickToRevealField')}</span>
        </p>
      </div>
    </div>
  );
};

interface CleanableProps {
  handleCleanClick: () => void;
  cleanable: React.ReactNode;
}

const Cleanable: React.FC<CleanableProps> = ({ cleanable, handleCleanClick }) =>
  cleanable ? <CleanButton onClick={handleCleanClick} /> : null;

interface CopyableProps {
  value: React.ReactNode;
  copy: () => void;
  cleanable: React.ReactNode;
  copyable: React.ReactNode;
}

const Copyable: React.FC<CopyableProps> = ({ copy, cleanable, value, copyable }) =>
  copyable ? (
    <CopyButton
      style={{
        position: 'absolute',
        bottom: cleanable ? '3px' : '0px',
        right: cleanable ? '30px' : '5px'
      }}
      text={value as string}
      type="link"
    >
      <CopyIcon
        style={{ verticalAlign: 'inherit' }}
        className={classNames('h-4 ml-1 w-auto inline', 'stroke-orange stroke-2')}
        onClick={() => copy()}
      />
    </CopyButton>
  ) : null;

interface ErrorCaptionProps {
  errorCaption: React.ReactNode;
}

const ErrorCaption: React.FC<ErrorCaptionProps> = ({ errorCaption }) => {
  const isPasswordStrengthIndicator = errorCaption === PASSWORD_ERROR_CAPTION;

  return errorCaption && !isPasswordStrengthIndicator ? (
    <div className="text-xs text-red-500">{errorCaption}</div>
  ) : null;
};

interface LabelComponentProps {
  className: string;
  label: ReactNode;
  description: ReactNode;
  warning: ReactNode;
  descriptionClassName?: string;
  id?: string;
}

const LabelComponent: React.FC<LabelComponentProps> = ({
  label,
  className,
  description,
  warning,
  id,
  descriptionClassName
}) =>
  label ? (
    <label className={classNames('leading-tight', 'flex flex-col', 'mb-4')} htmlFor={id}>
      <span className={classNames('text-heading-gray font-medium text-[20px]', className)}>{label}</span>

      {description && (
        <span className={classNames('mt-2', 'text-sm text-black leading-4', descriptionClassName)}>{description}</span>
      )}

      {warning && <span className={classNames('mt-1', 'text-xs font-medium text-red-600')}>{warning}</span>}
    </label>
  ) : null;

const getInnerClassName = (isPasswordInput: boolean, extraInner: ReactNode) => {
  const passwordClassName = isPasswordInput ? 'pr-12' : 'pr-4';
  return extraInner ? 'pr-20' : passwordClassName;
};

export default FormField;
