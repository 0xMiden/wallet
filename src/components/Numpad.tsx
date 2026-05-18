import React from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface NumpadProps {
  onDigit: (digit: string) => void;
  onDelete: () => void;
  className?: string;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const keyClass =
  'size-23 rounded-2xl bg-gray-25 text-heading-gray text-[34px] font-medium flex items-center justify-center select-none';

export const Numpad: React.FC<NumpadProps> = ({ onDigit, onDelete, className }) => {
  const handleDigit = (digit: string) => {
    hapticLight();
    onDigit(digit);
  };

  const handleDelete = () => {
    hapticLight();
    onDelete();
  };

  return (
    <div className={cn('grid grid-cols-3 gap-4 w-fit mx-auto', className)}>
      {DIGITS.map(digit => (
        <button key={digit} type="button" className={keyClass} onClick={() => handleDigit(digit)}>
          {digit}
        </button>
      ))}
      <div aria-hidden="true" />
      <button type="button" className={keyClass} onClick={() => handleDigit('0')}>
        0
      </button>
      <button
        type="button"
        aria-label="Delete"
        className="size-23 rounded-2xl text-heading-gray flex items-center justify-center select-none"
        onClick={handleDelete}
      >
        <Icon name={IconName.Backspace} size="lg" />
      </button>
    </div>
  );
};

export default Numpad;
