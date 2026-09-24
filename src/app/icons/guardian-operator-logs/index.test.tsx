import React from 'react';

import { render } from '@testing-library/react';

import { GUARDIAN_LOGOS, guardianLogoColorClass } from '.';

// OpenZeppelin's brand kit gives the wallet a standalone colour mark
// (`Favicon/OZ-Logo-FavIconColor.svg`) alongside its wordmark, and its
// wordmark text is a fixed black or white per file rather than `currentColor`
// (see the brand kit) — so it opts out of the shared grey recolor entirely.
// This is the one entry every consumer (GuardianSettings' hero, ChooseGuardian's
// provider cards) branches on, so it is pinned here directly rather than only
// indirectly through those screens' tests.
describe('GUARDIAN_LOGOS', () => {
  it('marks OpenZeppelin as brand-color and gives it a standalone colour mark', () => {
    const oz = GUARDIAN_LOGOS['open-zeppelin']!;

    expect(oz).toBeDefined();
    expect(oz.keepBrandColor).toBe(true);
    expect(oz.Mark).toBeDefined();
    expect(guardianLogoColorClass(oz)).toBe('text-ink');
  });

  it("renders OpenZeppelin's light and dark wordmark variants toggled by theme, not one recolored asset", () => {
    const oz = GUARDIAN_LOGOS['open-zeppelin']!;
    const { container } = render(<oz.Logo className="h-12" />);

    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0]).toHaveClass('block', 'dark:hidden', 'h-12');
    expect(svgs[1]).toHaveClass('hidden', 'dark:block', 'h-12');
  });

  it('gives Gateway and Kodax a mark cut from their wordmarks, and Lambda Class none', () => {
    expect(GUARDIAN_LOGOS.gateway!.Mark).toBeDefined();
    expect(GUARDIAN_LOGOS.kodax!.Mark).toBeDefined();
    expect(GUARDIAN_LOGOS.kodax!.keepBrandColor).toBe(true);
    // No standalone mark in Lambda Class's kit: its wordmark is scaled into the tile instead.
    expect(GUARDIAN_LOGOS['lambda-class']!.Mark).toBeUndefined();
  });
});
