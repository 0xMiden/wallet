import React from 'react';

import { render, screen } from '@testing-library/react';

import { Notice, NoticeTone } from './Notice';

it('renders the body as a note, with no title or glyph unless given', () => {
  render(<Notice data-testid="notice">Only send test tokens here.</Notice>);

  const notice = screen.getByTestId('notice');
  expect(notice).toHaveAttribute('role', 'note');
  expect(notice).toHaveTextContent('Only send test tokens here.');
  expect(notice.querySelector('[data-slot="title"]')).toBeNull();
  expect(notice.querySelector('[data-slot="icon"]')).toBeNull();
});

it('draws a tinted 16px-radius surface with no border', () => {
  render(<Notice data-testid="notice">Body</Notice>);

  const notice = screen.getByTestId('notice');
  expect(notice).toHaveClass('rounded-2xl', 'bg-fill');
  expect(notice.className).not.toMatch(/\bborder\b|border-dashed/);
});

it('renders the title above the body and the glyph as decoration', () => {
  render(
    <Notice data-testid="notice" title="Test tokens only" icon={<svg data-testid="glyph" />}>
      Body
    </Notice>
  );

  const notice = screen.getByTestId('notice');
  expect(notice.querySelector('[data-slot="title"]')).toHaveTextContent('Test tokens only');
  expect(notice.querySelector('[data-slot="icon"]')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByTestId('glyph')).toBeInTheDocument();
});

it.each<[NoticeTone, string, string, string]>([
  ['neutral', 'bg-fill', 'text-ink', 'text-muted'],
  ['warning', 'bg-status-pending/10', 'text-pending-ink', 'text-ink'],
  ['negative', 'bg-status-negative/10', 'text-negative-ink', 'text-ink'],
  ['positive', 'bg-status-positive/10', 'text-positive-ink', 'text-ink']
])('paints the %s tone from tokens', (tone, surface, ink, body) => {
  render(
    <Notice data-testid="notice" tone={tone} title="Title" icon={<svg />}>
      Body
    </Notice>
  );

  const notice = screen.getByTestId('notice');
  expect(notice).toHaveClass(surface);
  expect(notice).toHaveAttribute('data-tone', tone);
  expect(notice.querySelector('[data-slot="icon"]')).toHaveClass(ink);
  expect(notice.querySelector('[data-slot="title"]')).toHaveClass(ink, 'text-label');
  expect(notice.querySelector('[data-slot="body"]')).toHaveClass(body, 'text-caption');
});

it('drops the surface for the inline variant, keeping the tone on the glyph', () => {
  render(
    <Notice data-testid="notice" tone="warning" variant="inline" icon={<svg />}>
      Body
    </Notice>
  );

  const notice = screen.getByTestId('notice');
  expect(notice).toHaveAttribute('data-variant', 'inline');
  expect(notice).toHaveAttribute('data-tone', 'warning');
  // No tint, no radius, no card padding: a caption line under what it qualifies.
  expect(notice.className).not.toMatch(/(^|\s)bg-|rounded-2xl/);
  expect(notice.querySelector('[data-slot="icon"]')).toHaveClass('text-pending-ink');
  expect(notice.querySelector('[data-slot="body"]')).toHaveClass('text-caption', 'text-muted');
});

it('marks the tinted card as the default variant', () => {
  render(<Notice data-testid="notice">Body</Notice>);

  expect(screen.getByTestId('notice')).toHaveAttribute('data-variant', 'block');
});

it('takes an alert role for something that just went wrong', () => {
  render(
    <Notice data-testid="notice" tone="negative" role="alert">
      Failed
    </Notice>
  );

  expect(screen.getByTestId('notice')).toHaveAttribute('role', 'alert');
});

it('merges a layout className', () => {
  render(
    <Notice data-testid="notice" className="mt-5">
      Body
    </Notice>
  );

  expect(screen.getByTestId('notice')).toHaveClass('mt-5', 'w-full');
});
