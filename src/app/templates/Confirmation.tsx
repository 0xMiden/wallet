import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button } from 'app/atoms/Button';
import { useAppEnv } from 'app/env';
import { ReactComponent as InfoIcon } from 'app/icons/info-alert.svg';
import { ReactComponent as SuccessIcon } from 'app/icons/success.svg';
import useTippy from 'lib/ui/useTippy';
import Link from 'lib/woozie/Link';

type ConfirmationProps = {
  delegated: boolean;
  testId: string;
};

const Confirmation: FC<ConfirmationProps> = ({ delegated, testId }) => {
  const { t } = useTranslation();
  const { fullPage } = useAppEnv();
  const proofGenerationTippyProps = {
    trigger: 'mouseenter',
    hideOnClick: false,
    content: t('proofGenerationTab'),
    animation: 'shift-away-subtle'
  };
  const helpRef = useTippy<HTMLSpanElement>(proofGenerationTippyProps);
  return (
    <>
      <div>
        <div className={classNames('w-full max-w-sm mx-auto')}>
          <div
            className="flex flex-col items-center justify-center m-auto"
            style={{
              marginTop: '85px',
              width: '160px',
              height: '160px',
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='160' height='160' viewBox='0 0 160 160' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cg clip-path='url(%23clip0_4733_10154)'%3E%3Crect x='-142' y='34' width='284' height='248' fill='url(%23paint0_radial_4733_10154)'/%3E%3Crect x='90' y='-68' width='284' height='248' fill='url(%23paint1_radial_4733_10154)'/%3E%3C/g%3E%3Cdefs%3E%3CradialGradient id='paint0_radial_4733_10154' cx='0' cy='0' r='1' gradientUnits='userSpaceOnUse' gradientTransform='translate(0 158) rotate(90) scale(124 142)'%3E%3Cstop stop-color='%23EFE0FB'/%3E%3Cstop offset='1' stop-color='%23EFE0FB' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='paint1_radial_4733_10154' cx='0' cy='0' r='1' gradientUnits='userSpaceOnUse' gradientTransform='translate(232 56) rotate(90) scale(124 142)'%3E%3Cstop stop-color='%23EFE0FB'/%3E%3Cstop offset='1' stop-color='%23EFE0FB' stop-opacity='0'/%3E%3C/radialGradient%3E%3CclipPath id='clip0_4733_10154'%3E%3Crect width='160' height='160' rx='80' fill='white'/%3E%3C/clipPath%3E%3C/defs%3E%3C/svg%3E")`
            }}
          >
            <SuccessIcon height="53px" width="54px" />
          </div>
          <div className="font-semibold text-center mt-4" style={{ fontSize: '18px', lineHeight: '24px' }}>
            {t('transactionInitiated')}
          </div>
          <div className="text-center mt-2" style={{ fontSize: '14px', lineHeight: '20px' }}>
            {delegated ? t('transactionDelegated') : t('transactionBackground')}
          </div>
          <div
            className="flex text-center mt-6 rounded-lg"
            style={{ fontSize: '14px', lineHeight: '20px', backgroundColor: '#ECF5FF', padding: '12px 28px' }}
          >
            <div>
              <span ref={helpRef}>
                <InfoIcon stroke={'none'} style={{ height: '16px', width: '16px', marginTop: '2px' }} />
              </span>
            </div>
            <div className="flex flex-col px-2 text-left">
              <span className="font-medium" style={{ fontSize: '14px', lineHeight: '20px', marginBottom: '4px' }}>
                {delegated ? t('fastTransaction') : t('speedUpTransaction')}
                <br />
              </span>
              <span className="text-xs">{delegated ? t('fastTransactionDescription') : t('openedNewTab')}</span>
            </div>
          </div>
        </div>
      </div>
      <div
        className={`flex flex-col justify-end ${fullPage ? 'mb-8' : 'mb-2'}`}
        style={{ maxHeight: 'fit-content', height: `${fullPage ? '12.5rem' : '8.5rem'}` }}
      >
        <div className="flex flex-row justify-between w-full">
          <div className={classNames('w-full max-w-sm mx-auto')}>
            <Link to="/">
              <Button
                className={classNames(
                  'w-full justify-center',
                  'px-8',
                  'rounded-lg',
                  'bg-chip-bg',
                  'hover:bg-gray-100',
                  'active:bg-gray-100',
                  'flex items-center',
                  'text-black',
                  'font-semibold',
                  'transition duration-200 ease-in-out'
                )}
                style={{
                  fontSize: '16px',
                  lineHeight: '24px',
                  padding: '14px 0px'
                }}
                onClick={() => {}}
                testID={testId}
              >
                {t('home')}
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </>
  );
};

export default Confirmation;
