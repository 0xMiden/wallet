import React, { FC, HTMLAttributes, ReactNode, useEffect, useRef } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as CloseIcon } from 'app/icons/close.svg';

type AlertProps = HTMLAttributes<HTMLDivElement> & {
  type?: 'success' | 'warn' | 'error';
  title?: ReactNode;
  description: ReactNode;
  autoFocus?: boolean;
  closable?: boolean;
  onClose?: () => void;
};

const Alert: FC<AlertProps> = ({
  type = 'warn',
  title,
  description,
  autoFocus,
  className,
  closable,
  onClose,
  ...rest
}) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);

  const [bgColorClassName, textColorClassName] = (() => {
    switch (type) {
      case 'success':
        return ['bg-green-100', 'text-green-700'];
      case 'warn':
        return ['bg-yellow-100', 'text-yellow-700'];
      case 'error':
        return ['bg-red-100', 'text-red-700'];
    }
  })();

  return (
    <div
      ref={ref}
      className={classNames('relative w-full px-4 py-4', bgColorClassName, textColorClassName, className)}
      tabIndex={-1}
      role="alert"
      aria-label={t('alert')}
      {...rest}
    >
      {title && <h2 className="mb-1 text-lg font-semibold">{title}</h2>}
      {description && <div className={classNames('text-sm  break-words', 'overflow-y-auto')}>{description}</div>}
      {closable && (
        <button className="absolute top-3 right-3 cursor-pointer" onClick={onClose} type="button">
          <CloseIcon className="w-auto h-5 stroke-current" style={{ strokeWidth: 2 }} />
        </button>
      )}
    </div>
  );
};

export default Alert;
