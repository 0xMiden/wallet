import React from 'react';

import { render, screen } from '@testing-library/react';

import { Avatar } from './Avatar';

it('renders an image when given one, over initials or an icon', () => {
  render(
    <Avatar
      data-testid="avatar"
      image="https://example.com/pic.png"
      alt="Ada"
      initials="AL"
      icon={<svg data-testid="icon" />}
    />
  );

  const img = screen.getByAltText('Ada') as HTMLImageElement;
  expect(img.src).toBe('https://example.com/pic.png');
  expect(screen.queryByText('AL')).not.toBeInTheDocument();
  expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
});

it('falls back to initials on a colored background when there is no image', () => {
  render(<Avatar data-testid="avatar" initials="AL" color="#8FA58A" />);

  const avatar = screen.getByTestId('avatar');
  const circle = avatar.firstChild as HTMLElement;
  expect(circle.style.backgroundColor).toBe('rgb(143, 165, 138)');
  expect(circle).toHaveTextContent('AL');
});

it('falls back to an icon when there is no image or initials', () => {
  render(<Avatar icon={<svg data-testid="icon" />} />);
  expect(screen.getByTestId('icon')).toBeInTheDocument();
});

it('hides initials from the accessibility tree (decorative next to a named contact/token)', () => {
  render(<Avatar initials="AL" />);
  const initials = screen.getByText('AL');
  expect(initials).toHaveAttribute('aria-hidden', 'true');
});

it('defaults the image to a decorative (empty) alt when none is given', () => {
  const { container } = render(<Avatar image="https://example.com/pic.png" />);
  const img = container.querySelector('img') as HTMLImageElement;
  // An empty alt takes the <img> out of the accessibility tree (an implicit
  // "presentation" role) rather than announcing the bare URL.
  expect(img).toHaveAttribute('alt', '');
});

it('ignores `color` once an image is set (no inline background under the picture)', () => {
  render(<Avatar data-testid="avatar" image="https://example.com/pic.png" color="#8FA58A" />);
  const circle = screen.getByTestId('avatar').firstChild as HTMLElement;
  expect(circle.style.backgroundColor).toBe('');
});

it('sizes the box for each step of the scale', () => {
  const { rerender } = render(<Avatar data-testid="avatar" size={24} initials="A" />);
  expect(screen.getByTestId('avatar').firstChild as HTMLElement).toHaveClass('h-6', 'w-6');

  rerender(<Avatar data-testid="avatar" size={36} initials="A" />);
  expect(screen.getByTestId('avatar').firstChild as HTMLElement).toHaveClass('h-9', 'w-9');

  rerender(<Avatar data-testid="avatar" size={40} initials="A" />);
  expect(screen.getByTestId('avatar').firstChild as HTMLElement).toHaveClass('h-10', 'w-10');

  rerender(<Avatar data-testid="avatar" size={88} initials="A" />);
  expect(screen.getByTestId('avatar').firstChild as HTMLElement).toHaveClass('h-22', 'w-22');
});

it('defaults to size 40', () => {
  render(<Avatar data-testid="avatar" initials="A" />);
  expect(screen.getByTestId('avatar').firstChild as HTMLElement).toHaveClass('h-10', 'w-10');
});

it('is round at every size', () => {
  render(<Avatar data-testid="avatar" initials="A" />);
  expect(screen.getByTestId('avatar').firstChild as HTMLElement).toHaveClass('rounded-full');
});

it('applies a caller className to the visible circle, so a caller can restyle its shape (e.g. a squared token tile)', () => {
  render(<Avatar data-testid="avatar" initials="A" className="rounded-10" />);

  const circle = screen.getByTestId('avatar').firstChild as HTMLElement;
  // Additive: the circle keeps its base classes (size, rounded-full) alongside
  // the caller's override — Tailwind's own cascade decides which radius wins.
  expect(circle).toHaveClass('rounded-10', 'rounded-full', 'h-10', 'w-10');
});

it('forwards an arbitrary data-* attribute to the root, alongside data-testid', () => {
  render(<Avatar data-testid="avatar" data-network="ethereum" initials="A" />);
  expect(screen.getByTestId('avatar')).toHaveAttribute('data-network', 'ethereum');
});

it('renders a corner badge sized to the avatar, only when given one', () => {
  const { container, rerender } = render(<Avatar size={88} badge={<span data-testid="badge-glyph" />} initials="A" />);
  const badge = screen.getByTestId('badge-glyph').parentElement!;
  expect(badge).toHaveClass('absolute', 'rounded-full', 'h-8', 'w-8');

  rerender(<Avatar size={88} initials="A" />);
  expect(container.querySelectorAll('.absolute')).toHaveLength(0);
});

it('sizes the badge down for the 40px avatar', () => {
  render(<Avatar size={40} badge={<span data-testid="badge-glyph" />} initials="A" />);
  expect(screen.getByTestId('badge-glyph').parentElement).toHaveClass('h-5', 'w-5');
});
