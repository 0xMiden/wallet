import { ReactComponent as GatewayLogo } from './gateway.svg';
import { ReactComponent as KodaxLogo } from './kodax.svg';
import { ReactComponent as LambdaClassLogo } from './lambdaclass.svg';
import { ReactComponent as OpenZeppelinMark } from './open-zeppelin-mark.svg';
import { ReactComponent as OpenZeppelinLogo } from './open-zeppelin.svg';

export interface GuardianLogoEntry {
  Logo: ImportedSVGComponent;
  // Horizontal padding tuned per wordmark for the ChooseGuardian provider cards.
  paddingXClass: string;
  // Grey (#484848) marks get `[&_path]:fill-ink` at the render site to
  // recolor them to the auto-flipping heading token so they stay legible in both
  // themes; `keepBrandColor` opts a logo out of the blanket recolor — its
  // `currentColor` paths pick up the heading token via `text-ink`
  // while hardcoded brand-color paths stay untouched.
  keepBrandColor?: boolean;
  // OpenZeppelin's colour "Z" mark, standalone (no wordmark) — from the official
  // brand kit's Favicon asset. Only a provider whose brand kit ships this kind of
  // standalone mark carries it; GuardianSettings' hero uses its presence to
  // switch to the design-system Hero (mark in a circle + name), and every other
  // provider keeps the wordmark-in-a-tile hero layout.
  Mark?: ImportedSVGComponent;
}

// Brand wordmark per GUARDIAN_OPTIONS provider id.
export const GUARDIAN_LOGOS: Record<string, GuardianLogoEntry> = {
  'open-zeppelin': { Logo: OpenZeppelinLogo, Mark: OpenZeppelinMark, paddingXClass: 'px-4', keepBrandColor: true },
  gateway: { Logo: GatewayLogo, paddingXClass: 'px-3' },
  'lambda-class': { Logo: LambdaClassLogo, paddingXClass: 'px-5' },
  kodax: { Logo: KodaxLogo, paddingXClass: 'px-6', keepBrandColor: true }
};

// The theme-recolor classes described on GuardianLogoEntry, shared by every
// render site so all logos flip consistently.
export function guardianLogoColorClass(entry: GuardianLogoEntry): string {
  return entry.keepBrandColor ? 'text-ink' : '[&_path]:fill-ink';
}
