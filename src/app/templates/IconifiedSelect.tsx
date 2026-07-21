import React, { ComponentType, forwardRef, HTMLAttributes, ReactNode, useCallback } from 'react';

import classNames from 'clsx';

import DropdownWrapper from 'app/atoms/DropdownWrapper';
import { ReactComponent as ChevronDownIcon } from 'app/icons/chevron-down.svg';
import Popper, { PopperRenderProps } from 'lib/ui/Popper';

export type IconifiedSelectOptionRenderProps<T> = {
  option: T;
  index?: number;
};

type IconifiedSelectRenderComponent<T> = ComponentType<IconifiedSelectOptionRenderProps<T>>;

type IconifiedSelectProps<T> = {
  Icon: IconifiedSelectRenderComponent<T>;
  OptionSelectedIcon: IconifiedSelectRenderComponent<T>;
  OptionInMenuContent: IconifiedSelectRenderComponent<T>;
  OptionSelectedContent: IconifiedSelectRenderComponent<T>;
  getKey: (option: T) => string | number | undefined;
  isDisabled?: (option: T) => boolean;
  options: T[];
  value: T;
  onChange?: (a: T) => void;
  className?: string;
  title: ReactNode;
};

const IconifiedSelect = <T extends unknown>({
  Icon,
  OptionInMenuContent,
  OptionSelectedIcon,
  OptionSelectedContent,
  getKey,
  isDisabled,
  options,
  value,
  onChange,
  className,
  title
}: IconifiedSelectProps<T>) => {
  return (
    <div className={className}>
      {options.length > 1 ? (
        <>
          {title}

          <Popper
            placement="bottom"
            strategy="fixed"
            modifiers={[sameWidth]}
            popup={({ opened, setOpened, toggleOpened }) => (
              <IconifiedSelectMenu
                isDisabled={isDisabled}
                opened={opened}
                setOpened={setOpened}
                toggleOpened={toggleOpened}
                onChange={onChange}
                Icon={Icon}
                OptionInMenuContent={OptionInMenuContent}
                getKey={getKey}
                options={options}
                value={value}
              />
            )}
          >
            {({ ref, toggleOpened }) => (
              <SelectButton
                ref={ref}
                Content={OptionSelectedContent}
                Icon={OptionSelectedIcon}
                value={value}
                dropdown
                onClick={toggleOpened}
              />
            )}
          </Popper>
        </>
      ) : (
        <>
          {title}
          <SelectButton Icon={OptionSelectedIcon} Content={OptionSelectedContent} value={value} />
        </>
      )}
    </div>
  );
};

export default IconifiedSelect;

type IconifiedSelectMenuProps<T> = PopperRenderProps &
  Omit<IconifiedSelectProps<T>, 'className' | 'title' | 'OptionSelectedContent' | 'OptionSelectedIcon'>;

const IconifiedSelectMenu = <T extends unknown>(props: IconifiedSelectMenuProps<T>) => {
  const { isDisabled, opened, setOpened, onChange, options, value, getKey, Icon, OptionInMenuContent } = props;
  const handleOptionClick = useCallback(
    (newValue: T) => {
      if (getKey(newValue) !== getKey(value)) {
        onChange?.(newValue);
      }
      setOpened(false);
    },
    [onChange, setOpened, value, getKey]
  );

  return (
    <DropdownWrapper
      opened={opened}
      className="origin-top overflow-x-hidden overflow-y-auto rounded-md"
      style={{
        maxHeight: '16rem',
        backgroundColor: 'white',
        borderColor: '#e2e8f0',
        boxShadow: `0px 3px 32px rgba(12, 12, 13, 0.16)`
      }}
    >
      {options.map(option => (
        <IconifiedSelectOption
          disabled={isDisabled?.(option)}
          key={getKey(option)}
          value={option}
          selected={getKey(option) === getKey(value)}
          onClick={handleOptionClick}
          Icon={Icon}
          OptionInMenuContent={OptionInMenuContent}
        />
      ))}
    </DropdownWrapper>
  );
};

type IconifiedSelectOptionProps<T> = Pick<IconifiedSelectProps<T>, 'Icon' | 'OptionInMenuContent' | 'value'> & {
  disabled?: boolean;
  value: T;
  selected: boolean;
  onClick?: IconifiedSelectProps<T>['onChange'];
};

const IconifiedSelectOption = <T extends unknown>(props: IconifiedSelectOptionProps<T>) => {
  const { disabled, value, selected, onClick, Icon, OptionInMenuContent } = props;

  const handleClick = useCallback(() => {
    onClick?.(value);
  }, [onClick, value]);

  return (
    <button
      type="button"
      className={classNames(
        'w-full',
        'mb-1',
        'rounded',
        'transition-colors ease-hover duration-150',
        selected ? 'bg-chip-bg' : !disabled && 'hover:bg-gray-100',
        'flex items-center',
        disabled && 'opacity-25',
        disabled ? 'cursor-default' : 'cursor-pointer',
        'text-left'
      )}
      disabled={disabled}
      style={{
        padding: '0.375rem 1.5rem 0.375rem 0.5rem',
        fontSize: '14px',
        lineHeight: '20px',
        paddingLeft: '8px',
        paddingTop: '16px',
        paddingBottom: '16px'
      }}
      autoFocus={selected}
      onClick={disabled ? undefined : handleClick}
    >
      <Icon option={value} />

      <OptionInMenuContent option={value} />
    </button>
  );
};

type SelectButtonProps = HTMLAttributes<HTMLButtonElement> &
  Pick<IconifiedSelectProps<any>, 'Icon' | 'value'> & {
    Content: IconifiedSelectProps<any>['OptionSelectedContent'];
    dropdown?: boolean;
  };

const SelectButton = forwardRef<HTMLButtonElement, SelectButtonProps>(
  ({ Content, Icon, value, dropdown, className, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={classNames(
          'w-full p-2',
          'border border-gray-100 rounded-lg',
          'flex items-center',
          dropdown ? 'cursor-pointer' : 'cursor-default',
          className
        )}
        {...rest}
      >
        <Icon option={value} />

        <div className=" leading-none">
          <div className="flex items-center">
            <Content option={value} />
          </div>
        </div>

        {dropdown && (
          <>
            <div className="flex-1" />

            <ChevronDownIcon className={classNames('mx-2 h-5 w-auto', 'text-black', 'stroke-current stroke-2')} />
          </>
        )}
      </button>
    );
  }
);

// Modifier to make popup same width as trigger - handled by floating-ui size middleware
const sameWidth = {
  name: 'sameWidth',
  enabled: true
};
