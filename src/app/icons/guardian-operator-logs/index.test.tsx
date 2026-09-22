import React from 'react';

import { render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

import { GUARDIAN_LOGOS, guardianLogoColorClass } from '.';

// OpenZeppelin's brand kit gives the wallet a standalone colour mark
// (`Favicon/OZ-Logo-FavIconColor.svg`) alongside its wordmark. The wordmark is
// one asset whose text paths are `currentColor`, so `text-ink` recolors it for
// both themes, and only the three brand-colour paths stay literal. This is the
// one entry every consumer (GuardianSettings' hero, ChooseGuardian's provider
// cards) branches on, so it is pinned here directly rather than only indirectly
// through those screens' tests.
describe('GUARDIAN_LOGOS', () => {
  it('marks OpenZeppelin as brand-color and gives it a standalone colour mark', () => {
    const oz = GUARDIAN_LOGOS['open-zeppelin']!;

    expect(oz).toBeDefined();
    expect(oz.keepBrandColor).toBe(true);
    expect(oz.Mark).toBeDefined();
    expect(guardianLogoColorClass(oz)).toBe('text-ink');
  });

  // The jest svg transform renders every import as a bare `<svg>`, so a render
  // assertion can never see a `fill`. Read the asset, the way copyIcon.test.ts
  // already does for the copy glyphs: a baked-in `fill="black"` wins over the
  // `text-ink` class and leaves the wordmark invisible on a dark page, and a
  // count-only assertion passes on exactly that.
  it('ships ONE wordmark asset whose text inherits the theme colour', () => {
    const oz = GUARDIAN_LOGOS['open-zeppelin']!;
    const { container } = render(<oz.Logo className="h-12" />);

    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });

  it('leaves no hardcoded black in the wordmark and keeps the three brand fills', () => {
    const svg = readFileSync(join(__dirname, 'open-zeppelin.svg'), 'utf8');

    expect(svg).not.toContain('fill="black"');
    expect(svg).toContain('fill="currentColor"');
    // The brand palette is NOT recolored: these three stay literal in both themes.
    expect(svg).toContain('fill="#2E99FF"');
    expect(svg).toContain('fill="#4F56FA"');
    expect(svg).toContain('fill="#09C2FF"');
  });

  it('ships no second fixed-colour wordmark to drift from the first', () => {
    expect(() => readFileSync(join(__dirname, 'open-zeppelin-dark.svg'))).toThrow();
  });

  it('gives no other provider a Mark, so they keep the wordmark-tile hero layout', () => {
    expect(GUARDIAN_LOGOS.gateway!.Mark).toBeUndefined();
    expect(GUARDIAN_LOGOS['lambda-class']!.Mark).toBeUndefined();
    // Kodax is also `keepBrandColor`, but ships no standalone mark — it must
    // stay on the wordmark-tile layout too, not follow OpenZeppelin's Hero.
    expect(GUARDIAN_LOGOS.kodax!.keepBrandColor).toBe(true);
    expect(GUARDIAN_LOGOS.kodax!.Mark).toBeUndefined();
  });
});
