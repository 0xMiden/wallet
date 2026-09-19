import React from 'react';

import clsx from 'clsx';

import { ReactComponent as GatewayMark } from './gateway-mark.svg';
import { ReactComponent as GatewayLogo } from './gateway.svg';
import { ReactComponent as KodaxMark } from './kodax-mark.svg';
import { ReactComponent as KodaxLogo } from './kodax.svg';
import { ReactComponent as LambdaClassLogo } from './lambdaclass.svg';
import { ReactComponent as OpenZeppelinLogoDark } from './open-zeppelin-dark.svg';
import { ReactComponent as OpenZeppelinMark } from './open-zeppelin-mark.svg';
import { ReactComponent as OpenZeppelinLogoLight } from './open-zeppelin.svg';

export interface GuardianLogoEntry {
  Logo: ImportedSVGComponent;
  // Grey (#484848) marks get `[&_path]:fill-ink` at the render site to
  // recolor them to the auto-flipping heading token so they stay legible in both
  // themes; `keepBrandColor` opts a logo out of the blanket recolor — its
  // `currentColor` paths pick up the heading token via `text-ink`
  // while hardcoded brand-color paths stay untouched.
  keepBrandColor?: boolean;
  // The provider's standalone mark (no wordmark), drawn in `GuardianLogoTile`: the
  // square tile on a guardian choice card and the circle in GuardianSettings' hero.
  // OpenZeppelin's is its brand kit's colour "Z" (the Favicon asset); Gateway's and
  // Kodax's are the icon glyphs cut from the left of their own wordmarks, paths
  // unchanged. A provider without one (Lambda Class ships no standalone mark) shows
  // its wordmark scaled into the same tile.
  Mark?: ImportedSVGComponent;
}

// OpenZeppelin's official wordmark ships as two fixed-color files rather than one
// `currentColor` mark: the wordmark text is literal black or white per file (see
// the brand kit), not `currentColor`, so a single asset recolored via CSS can't
// serve both themes the way the grey wordmarks below do. Render both and toggle
// with `dark:`, the same fixed-palette pattern as everywhere else in the wallet
// (CLAUDE.md's Tailwind notes) — `keepBrandColor` on the entry below already
// opts this logo out of the blanket grey recolor other providers get.
const OpenZeppelinLogo: ImportedSVGComponent = ({ className, ...rest }) => (
  <>
    <OpenZeppelinLogoLight {...rest} className={clsx('block dark:hidden', className)} />
    <OpenZeppelinLogoDark {...rest} className={clsx('hidden dark:block', className)} />
  </>
);

// Brand wordmark per GUARDIAN_OPTIONS provider id.
export const GUARDIAN_LOGOS: Record<string, GuardianLogoEntry> = {
  'open-zeppelin': { Logo: OpenZeppelinLogo, Mark: OpenZeppelinMark, keepBrandColor: true },
  gateway: { Logo: GatewayLogo, Mark: GatewayMark },
  'lambda-class': { Logo: LambdaClassLogo },
  kodax: { Logo: KodaxLogo, Mark: KodaxMark, keepBrandColor: true }
};

// The theme-recolor classes described on GuardianLogoEntry, shared by every
// render site so all logos flip consistently.
export function guardianLogoColorClass(entry: GuardianLogoEntry): string {
  return entry.keepBrandColor ? 'text-ink' : '[&_path]:fill-ink';
}
