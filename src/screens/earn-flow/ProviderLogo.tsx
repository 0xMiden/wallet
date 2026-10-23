import React, { FC, useState } from 'react';

import classNames from 'clsx';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';

/** True for an Aave protocol name: "Aave", or a version of it such as "Aave V3". */
const isAave = (protocol: string): boolean => protocol === 'Aave' || protocol.startsWith('Aave ');

const IMAGE_CLASS = 'h-full w-full object-contain';

/**
 * A lending protocol's mark, drawn in ink so it reads on both themes (inside a CardButton it would otherwise take the
 * button's UA text colour). The order is: the vault's document logo (`logoUrl`, from the config repo), else the logo
 * the app ships, else the protocol's initial. A document logo that does not load falls back without a notice.
 *
 * A document logo is drawn only through an `<img>`: an SVG in an image context runs no script. It is a CORS request
 * (`crossOrigin="anonymous"`), so the extension's `require-corp` embedder policy admits it on the host's
 * `Access-Control-Allow-Origin: *`, and it sends no referrer.
 */
export const ProviderLogo: FC<{ protocol: string; logoUrl?: string; className?: string }> = ({
  protocol,
  logoUrl,
  className
}) => {
  // The URL that failed, so a new URL is tried again.
  const [failedUrl, setFailedUrl] = useState<string>();

  const mark = () => {
    if (logoUrl !== undefined && logoUrl !== failedUrl) {
      return (
        <img
          key={logoUrl}
          src={logoUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          crossOrigin="anonymous"
          draggable={false}
          className={IMAGE_CLASS}
          onError={() => setFailedUrl(logoUrl)}
        />
      );
    }
    if (isAave(protocol)) return <img src={aaveLogoUrl} alt="" className={IMAGE_CLASS} />;
    return protocol.charAt(0);
  };

  return (
    <span className={classNames('flex shrink-0 items-center justify-center text-ink', className)} aria-hidden="true">
      {mark()}
    </span>
  );
};
