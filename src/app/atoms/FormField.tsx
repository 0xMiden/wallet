import React, {
  forwardRef,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
  useCallback,
  useState
} from 'react';

import classNames from 'clsx';

import CleanButton from 'app/atoms/CleanButton';
import { blurHandler, checkedHandler, focusHandler } from 'lib/ui/inputHandlers';

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
  cleanable?: boolean;
  extraButton?: ReactNode;
  extraInner?: ReactNode;
  useDefaultInnerWrapper?: boolean;
  onClean?: () => void;
  fieldWrapperBottomMargin?: boolean;
  labelPaddingClassName?: string;
  dropdownInner?: ReactNode;
  labelClassName?: string;
  labelDescriptionClassName?: string;
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
      // `off` is overridden by browsers on password-TYPE inputs, which are exactly the fields this
      // default exists to protect, so a password field needs `new-password` specifically. Same
      // rule and same shape in `TextField`, which replaces this component.
      autoComplete = type === 'password' ? 'new-password' : 'off',
      fieldWrapperBottomMargin = true,
      labelPaddingClassName = '',
      labelClassName,
      labelDescriptionClassName,
      ...rest
    },
    ref
  ) => {
    const Field = textarea ? 'textarea' : 'input';

    const [passwordInputType, TogglePasswordIcon] = usePasswordToggle();
    const isPasswordInput = type === 'password';
    const inputType = isPasswordInput ? passwordInputType : type;

    const [localValue, setLocalValue] = useState(value ?? defaultValue ?? '');

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>) => {
        checkedHandler(e, onChange!, setLocalValue);
      },
      [onChange, setLocalValue]
    );

    const handleFocus = useCallback(
      (e: React.FocusEvent<HTMLInputElement> | React.FocusEvent<HTMLTextAreaElement>) => focusHandler(e, onFocus!),
      [onFocus]
    );
    const handleBlur = useCallback(
      (e: React.FocusEvent<HTMLInputElement> | React.FocusEvent<HTMLTextAreaElement>) => blurHandler(e, onBlur!),
      [onBlur]
    );

    const handleCleanClick = useCallback(() => {
      if (onClean) {
        onClean();
      }
    }, [onClean]);

    return (
      <div className={classNames('w-full flex flex-col', containerClassName)} style={containerStyle}>
        <LabelComponent
          label={label}
          warning={labelWarning}
          description={labelDescription}
          className={classNames(labelPaddingClassName, labelClassName)}
          id={id}
          descriptionClassName={labelDescriptionClassName}
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
              'border',
              'bg-fill focus:bg-transparent',
              // text-ink maps to --ds-ink → #3f3f3f in light,
              // white in dark. Without this the <input> inherits the browser
              // default (pure black), which renders the masked password dots
              // invisible against the dark field background.
              'text-ink',
              'outline-none',
              'transition ease-in-out duration-200',
              'leading-tight',
              'placeholder:text-text-muted placeholder:font-medium placeholder:text-sm',
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
            // Default Done label on mobile keyboards; textareas keep the
            // platform return key (Enter inserts a newline there). Callers
            // can override via the enterKeyHint prop (spread below).
            enterKeyHint={textarea ? undefined : 'done'}
            {...rest}
          />

          {localValue !== '' && isPasswordInput && TogglePasswordIcon}
          <ExtraInner innerComponent={extraInner} useDefaultInnerWrapper={useDefaultInnerWrapper} />

          {dropdownInner}

          {extraButton}

          <Cleanable cleanable={cleanable} handleCleanClick={handleCleanClick} />
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
        <span className="mx-4 text-xs font-medium text-ink">{innerComponent}</span>
      </div>
    );
  return <>{innerComponent}</>;
};

interface CleanableProps {
  handleCleanClick: () => void;
  cleanable: React.ReactNode;
}

const Cleanable: React.FC<CleanableProps> = ({ cleanable, handleCleanClick }) =>
  cleanable ? <CleanButton onClick={handleCleanClick} /> : null;

interface ErrorCaptionProps {
  errorCaption: React.ReactNode;
}

const ErrorCaption: React.FC<ErrorCaptionProps> = ({ errorCaption }) => {
  const isPasswordStrengthIndicator = errorCaption === PASSWORD_ERROR_CAPTION;

  return errorCaption && !isPasswordStrengthIndicator ? (
    <div className="text-xs text-red-500 wrap-break-word">{errorCaption}</div>
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
      <span className={classNames('text-ink font-medium text-[20px]', className)}>{label}</span>

      {description && (
        <span className={classNames('mt-2', 'text-sm text-ink leading-4', descriptionClassName)}>{description}</span>
      )}

      {warning && <span className={classNames('mt-1', 'text-xs font-medium text-red-600')}>{warning}</span>}
    </label>
  ) : null;

const getInnerClassName = (isPasswordInput: boolean, extraInner: ReactNode) => {
  const passwordClassName = isPasswordInput ? 'pr-12' : 'pr-4';
  return extraInner ? 'pr-20' : passwordClassName;
};

export default FormField;
