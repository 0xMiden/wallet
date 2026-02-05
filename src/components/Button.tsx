import React from 'react';

import classNames from 'clsx';

import { IconName } from 'app/icons/v2';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { IconOrComponent } from 'utils/icon-or-component';

import { Loader } from './Loader';

export enum ButtonVariant {
  Primary = 'primary',
  Secondary = 'secondary',
  Ghost = 'ghost',
  Danger = 'danger'
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
    color: 'text-white',
    disabledColor: 'text-grey-400',
    backgroundColor: 'bg-primary-500 focus:bg-primary-500',
    hoverBackgroundColor: 'hover:bg-primary-600',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'white',
    border: ''
  },
  [ButtonVariant.Secondary]: {
    color: 'text-black',
    disabledColor: 'text-grey-400',
    backgroundColor: 'bg-grey-50',
    hoverBackgroundColor: 'hover:bg-grey-100',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'black',
    border: ''
  },
  [ButtonVariant.Ghost]: {
    color: 'text-black',
    disabledColor: 'text-grey-400',
    backgroundColor: 'bg-transparent',
    hoverBackgroundColor: 'hover:bg-grey-50',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'black',
    border: 'border-[#0000004D] border-[0.5px]'
  },
  [ButtonVariant.Danger]: {
    color: 'text-white',
    disabledColor: 'text-grey-400',
    backgroundColor: 'bg-red-500',
    hoverBackgroundColor: 'hover:bg-red-600',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'white',
    border: ''
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
  let color = propsPerButtonVariant[variant].color;
  let backgroundColor = propsPerButtonVariant[variant].backgroundColor;
  let hoverBackgroundColor = propsPerButtonVariant[variant].hoverBackgroundColor;
  const iconColor = propsPerButtonVariant[variant].iconColor;
  const border = propsPerButtonVariant[variant].border;
  if (disabled) {
    backgroundColor = propsPerButtonVariant[variant].disabledBackgroundColor;
    color = propsPerButtonVariant[variant].disabledColor;
    hoverBackgroundColor = '';
  }

  const renderContent = () => {
    if (children) {
      return children;
    }

    return (
      <>
        {iconLeft && <span className="w-6">{<IconOrComponent icon={iconLeft} color={iconColor} />}</span>}
        {isLoading ? <Loader color={iconColor} /> : <span className={`${color} font-medium text-base`}>{title}</span>}
        {iconRight && <span className="w-6">{<IconOrComponent icon={iconRight} color={iconColor} />}</span>}
      </>
    );
  };

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    // Haptic feedback - medium for danger, light for others
    if (variant === ButtonVariant.Danger) {
      hapticMedium();
    } else {
      hapticLight();
    }
    props.onClick?.(e);
  };

  return (
    <button
      className={classNames(
        backgroundColor,
        hoverBackgroundColor,
        border,
        isLoading ? 'pointer-events-none' : '',
        'flex justify-center items-center gap-x-2',
        'py-3 px-4 rounded-4xl',
        'transition duration-300 ease-in-out',
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
