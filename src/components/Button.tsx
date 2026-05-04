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
    color: 'text-pure-white',
    disabledColor: 'text-pure-white',
    backgroundColor: 'bg-primary-500 focus:bg-primary-500',
    hoverBackgroundColor: 'hover:bg-primary-600',
    disabledBackgroundColor: 'bg-primary-500/60',
    iconColor: 'white',
    border: 'border-[0.5px] border-transparent'
  },
  [ButtonVariant.Secondary]: {
    color: 'text-heading-gray',
    disabledColor: 'text-grey-400',
    // Light-mode literal #E9E4E4 matches the existing design. In dark mode
    // text-heading-gray flips to white, so the bg has to darken too —
    // otherwise it's white-on-beige (see screenshot on Reveal Seed Phrase).
    // bg-gray-50 maps to --color-surface-tertiary → #f3f3f3 / #333333.
    backgroundColor: 'bg-[#E9E4E4] dark:bg-gray-50',
    hoverBackgroundColor: 'hover:bg-[#DDD8D8] dark:hover:bg-[#3f3f3f]',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'black',
    border: 'border-[0.5px] border-transparent'
  },
  [ButtonVariant.Ghost]: {
    color: 'text-black',
    disabledColor: 'text-grey-400',
    backgroundColor: 'bg-transparent',
    // bg-gray-50 maps to --color-surface-tertiary → #f3f3f3 / #333333 so the
    // hover state stays readable when text-black auto-flips to white in dark.
    // The previous bg-grey-50 was a literal #F3F3F3 → invisible white-on-light.
    hoverBackgroundColor: 'hover:bg-gray-50',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'black',
    border: 'border-[#0000004D] border-[0.5px]'
  },
  [ButtonVariant.Danger]: {
    color: 'text-pure-white',
    disabledColor: 'text-grey-400',
    backgroundColor: 'bg-red-500',
    hoverBackgroundColor: 'hover:bg-red-600',
    disabledBackgroundColor: 'bg-grey-200',
    iconColor: 'white',
    border: 'border-[0.5px] border-transparent'
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
        {isLoading ? <Loader color={iconColor} /> : <span className={`${color} font-medium`}>{title}</span>}
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
        'py-3 px-4 rounded-10',
        'transition duration-300 ease-in-out text-base',
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
