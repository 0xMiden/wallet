import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import DocBg from 'app/a11y/DocBg';
import { useAppEnv } from 'app/env';
import ContentContainer from 'app/layouts/ContentContainer';
import { isDesktop, isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';

interface SimplePageLayoutProps extends PropsWithChildren {
  title?: ReactNode;
  icon?: ReactNode;
}

const SimplePageLayout: FC<SimplePageLayoutProps> = ({ title, icon, children }) => {
  const { fullPage } = useAppEnv();
  // Platform-specific sizing:
  // - Mobile: 100% height/width to fill viewport (body has safe area padding)
  // - Desktop: responsive sizing (100% height, maxWidth: 600px, centered)
  // - Extension fullpage: fixed size (600x360)
  // - Extension popup: no explicit size
  let containerStyle: React.CSSProperties;
  if (isMobile()) {
    containerStyle = { height: '100%', width: '100%', overflow: 'hidden' };
  } else if (isDesktop()) {
    containerStyle = { height: '100%', width: '100%', maxWidth: '600px', margin: '0 auto', overflow: 'hidden' };
  } else if (fullPage) {
    containerStyle = { height: '600px', width: '360px', margin: 'auto', overflow: 'hidden' };
  } else {
    containerStyle = {};
  }
  // Only show shadow for extension fullpage mode
  const containerClass = fullPage && !isMobile() && !isDesktop() ? 'shadow-2xl' : '';

  return (
    <>
      <DocBg bgClassName="bg-app-bg" />

      <ContentContainer
        className={classNames('flex flex-col', 'bg-app-bg', 'rounded-lg', `${containerClass}`)}
        style={containerStyle}
      >
        <div className={classNames('flex flex-col items-center justify-center')}>
          {icon && (
            <div
              className={`flex w-full flex-row 'justify-start'`}
              style={{
                paddingLeft: '32px',
                paddingTop: '32px',
                paddingBottom: '112px',
                background: 'url(/misc/bg.svg) #F6F4F2 center top / 200% no-repeat'
              }}
            >
              {icon}
            </div>
          )}

          {title && (
            <div className={classNames('mt-4 w-full', 'text-left', 'text-lg text-medium  leading-tight', 'text-black')}>
              {title}
            </div>
          )}
        </div>

        <div className={classNames('bg-app-bg')}>{children}</div>

        <div className={classNames('flex-1', 'px-4 bg-app-bg')} />
      </ContentContainer>
    </>
  );
};

export default SimplePageLayout;
