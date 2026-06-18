import React, { FC, ReactNode } from 'react';

import { ReactComponent as ArrowRight } from 'app/icons/arrow-right.svg';
import { ReactComponent as Checkmark } from 'app/icons/checkmark-alt.svg';

interface PasswordStrengthIndicatorItemProps {
  isValid: boolean;
  message: ReactNode;
  title?: boolean;
}

const PasswordStrengthIndicatorItem: FC<PasswordStrengthIndicatorItemProps> = ({ isValid, message, title = false }) => {
  const icon = isValid ? (
    <Checkmark className="w-4 h-4 mr-1" />
  ) : (
    <ArrowRight className="w-4 h-4 mr-1" fill="currentColor" />
  );

  return title ? (
    <p className="text-sm mb-1">{message}</p>
  ) : (
    <div className="flex my-2 text-sm text-text-muted">
      <div className="flex flex-col justify-center">{icon}</div>
      <div className="px-4">{message}</div>
    </div>
  );
};

export default PasswordStrengthIndicatorItem;
