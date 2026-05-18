import React from 'react';

import { IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';
import { IconOrComponent } from 'utils/icon-or-component';

import { Loader } from './Loader';

export enum ButtonVariant {
  Primary = 'primary',
  Secondary = 'secondary',
  Ghost = 'ghost'
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  title?: string;
  iconLeft?: React.ReactNode | IconName;
  iconRight?: React.ReactNode | IconName;
  isLoading?: boolean;
}

const propsPerButtonVariant = {
  [ButtonVariant.Primary]: {
    color: 'text-pure-white',
    fontWeight: 'font-semibold',
    disabledColor: 'text-heading-gray',
    disabledFontWeight: 'font-semibold',
    backgroundColor: 'bg-primary-500 focus:bg-primary-500',
    hoverBackgroundColor: 'hover:bg-primary-600',
    disabledBackgroundColor: 'bg-surface-inactive',
    iconColor: 'white',
    border: 'border-[0.5px] border-transparent'
  },
  [ButtonVariant.Secondary]: {
    color: 'text-heading-gray',
    fontWeight: 'font-medium',
    disabledColor: 'text-heading-gray',
    disabledFontWeight: 'font-semibold',
    backgroundColor: 'bg-surface-interactive',
    hoverBackgroundColor: 'hover:bg-[#ECEAE7] dark:hover:bg-[#3f3f3f]',
    disabledBackgroundColor: 'bg-surface-inactive',
    iconColor: 'black',
    border: 'border-[0.5px] border-transparent'
  },
  [ButtonVariant.Ghost]: {
    color: 'text-heading-gray',
    fontWeight: 'font-medium',
    disabledColor: 'text-grey-400',
    disabledFontWeight: 'font-semibold',
    backgroundColor: 'bg-transparent',
    hoverBackgroundColor: 'hover:bg-grey-50',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'black',
    border: 'border border-border-button'
  }
};

export const Button: React.FC<ButtonProps> = ({
  variant = ButtonVariant.Primary,
  title = 'Button Title',
  iconRight,
  iconLeft,
  disabled,
  className,
  isLoading,
  children,
  ...props
}) => {
  const variantProps = propsPerButtonVariant[variant];
  let color = variantProps.color;
  let fontWeight = variantProps.fontWeight;
  let backgroundColor = variantProps.backgroundColor;
  let hoverBackgroundColor = variantProps.hoverBackgroundColor;
  const iconColor = variantProps.iconColor;
  const border = variantProps.border;
  if (disabled) {
    backgroundColor = variantProps.disabledBackgroundColor;
    color = variantProps.disabledColor;
    fontWeight = variantProps.disabledFontWeight;
    hoverBackgroundColor = '';
  }

  const renderContent = () => {
    if (children) {
      return children;
    }

    return (
      <>
        {iconLeft && <span className="w-6">{<IconOrComponent icon={iconLeft} color={iconColor} />}</span>}
        {isLoading ? <Loader color={iconColor} /> : <span className={cn(color, fontWeight)}>{title}</span>}
        {iconRight && <span className="w-6">{<IconOrComponent icon={iconRight} color={iconColor} />}</span>}
      </>
    );
  };

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    hapticLight();
    props.onClick?.(e);
  };

  return (
    <button
      className={cn(
        'flex justify-center items-center gap-x-2',
        // Fixed design-system dimensions: 370px × 56px (override with w-full etc via className).
        'max-w-92.5 h-14 px-4 rounded-10 w-full',
        'transition duration-300 ease-in-out text-base',
        backgroundColor,
        hoverBackgroundColor,
        border,
        isLoading && 'pointer-events-none',
        disabled ? 'cursor-default' : 'cursor-pointer',
        className
      )}
      disabled={disabled}
      type="button"
      {...props}
      onClick={onClick}
    >
      {renderContent()}
    </button>
  );
};
