import React from 'react';

import { render, screen } from '@testing-library/react';

import { ReactComponent as LogoComponent } from 'app/icons/brand/bread.svg';
import logoMarkup from 'app/icons/brand/new-bread.svg?raw';
import logoUrl from 'app/misc/logo.svg?url';

test('raw SVG imports provide markup that an SVG parser can consume', () => {
  expect(typeof logoMarkup).toBe('string');
  const parsed = new DOMParser().parseFromString(logoMarkup, 'image/svg+xml');
  expect(parsed.documentElement.nodeName).toBe('svg');
  expect(parsed.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(parsed.querySelector('parsererror')).toBeNull();
});

test('URL SVG imports remain image sources distinct from raw markup', () => {
  expect(typeof logoUrl).toBe('string');
  expect(logoUrl).not.toBe(logoMarkup);
  render(<img src={logoUrl} alt="Asset URL" />);
  expect(screen.getByAltText('Asset URL')).toHaveAttribute('src', logoUrl);
});

test('component SVG imports remain renderable SVG elements', () => {
  render(<LogoComponent data-testid="asset-component" />);
  expect(screen.getByTestId('asset-component').nodeName).toBe('svg');
  expect(screen.getByTestId('asset-component').namespaceURI).toBe('http://www.w3.org/2000/svg');
});
