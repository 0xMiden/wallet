import React, { Component, ErrorInfo, FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { PropsWithChildren } from 'lib/props-with-children';

import { WindowType } from './env';
import { Icon, IconName } from './icons/v2';

interface ErrorBoundaryProps extends PropsWithChildren {
  className?: string;
  whileMessage?: string;
  windowType?: WindowType;
}

type ErrorBoundaryState = {
  error: Error | null;
};

export default class ErrorBoundary extends Component<ErrorBoundaryProps> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(error.message, errorInfo.componentStack);
  }

  componentDidMount() {
    window.addEventListener('reseterrorboundary', () => {
      if (this.state.error) {
        this.tryAgain();
      }
    });
  }

  tryAgain() {
    this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorDisplay
          className={this.props.className}
          whileMessage={this.props.whileMessage}
          windowType={this.props.windowType}
        />
      );
    }

    return this.props.children;
  }
}

interface ErrorDisplayProps {
  className?: string;
  whileMessage?: string;
  windowType?: WindowType;
}

const ErrorDisplay: FC<ErrorDisplayProps> = ({ className, whileMessage, windowType }) => {
  const { t } = useTranslation();
  const online = getOnlineStatus();
  const fullPage = windowType === WindowType.FullPage;

  return (
    <div
      className={classNames(
        'w-full',
        'flex items-center justify-center bg-app-bg',
        className,
        fullPage && 'mt-[-24px]'
      )}
    >
      <div className={classNames('p-4', 'flex flex-col items-center', 'text-black')}>
        <Icon name={IconName.Frown} size="3xl" className="mb-8" />

        <h2 className="mb-1 text-2xl">{t('oops')}</h2>

        <p className="mb-4 text-sm opacity-90 text-center ">
          {whileMessage ? t('smthWentWrongWhile', { action: whileMessage }) : t('smthWentWrong')}
          {!online && (
            <>
              {'. '}
              {t('mayHappenBecauseYouAreOffline')}
            </>
          )}
        </p>

        <Button variant={ButtonVariant.Primary} title={t('tryAgain')} className="w-full mt-4" />
      </div>
    </div>
  );
};

function getOnlineStatus() {
  return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
}
