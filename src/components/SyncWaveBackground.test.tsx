import React from 'react';

import { render, screen } from '@testing-library/react';

import { SyncWaveBackground } from './SyncWaveBackground';

describe('SyncWaveBackground', () => {
  describe('when isSyncing is false', () => {
    it('renders nothing (returns null)', () => {
      const { container } = render(<SyncWaveBackground isSyncing={false} />);

      expect(container).toBeEmptyDOMElement();
    });

    it('ignores a supplied className and still renders nothing', () => {
      const { container } = render(<SyncWaveBackground isSyncing={false} className="extra-class" />);

      expect(container).toBeEmptyDOMElement();
      expect(container.querySelector('.extra-class')).toBeNull();
    });
  });

  describe('when isSyncing is true', () => {
    it('renders the outer wrapper with the base layout classes', () => {
      const { container } = render(<SyncWaveBackground isSyncing={true} />);

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toBeInTheDocument();
      expect(wrapper).toHaveClass('absolute', 'inset-0', 'overflow-hidden', 'pointer-events-none', 'z-10');
    });

    it('does not add extra classes when className is omitted', () => {
      const { container } = render(<SyncWaveBackground isSyncing={true} />);

      const wrapper = container.firstChild as HTMLElement;
      // clsx skips undefined, so only the five base classes remain.
      expect(wrapper.className.split(/\s+/).filter(Boolean)).toEqual([
        'absolute',
        'inset-0',
        'overflow-hidden',
        'pointer-events-none',
        'z-10'
      ]);
    });

    it('merges a supplied className onto the wrapper', () => {
      const { container } = render(<SyncWaveBackground isSyncing={true} className="my-custom-class" />);

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('my-custom-class');
      // Base classes are preserved alongside the custom one.
      expect(wrapper).toHaveClass('absolute', 'inset-0', 'overflow-hidden', 'pointer-events-none', 'z-10');
    });

    it('renders the animated shimmer wave child with animation classes', () => {
      const { container } = render(<SyncWaveBackground isSyncing={true} />);

      const wrapper = container.firstChild as HTMLElement;
      const shimmer = wrapper.firstElementChild as HTMLElement;

      expect(shimmer).toBeInTheDocument();
      expect(shimmer).toHaveClass('absolute', 'inset-0', 'animate-gradient-wave', 'motion-reduce:animate-none');
    });

    it('applies the gradient background and background-size inline styles to the shimmer', () => {
      const { container } = render(<SyncWaveBackground isSyncing={true} />);

      const shimmer = (container.firstChild as HTMLElement).firstElementChild as HTMLElement;

      expect(shimmer.style.background).toBe(
        'linear-gradient(90deg, transparent 0%, rgba(249, 115, 22, 0.3) 50%, transparent 100%)'
      );
      expect(shimmer.style.backgroundSize).toBe('200% 100%');
    });

    it('renders exactly one shimmer child inside the wrapper', () => {
      const { container } = render(<SyncWaveBackground isSyncing={true} />);

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.children).toHaveLength(1);
    });

    it('has no visible text content and is purely decorative', () => {
      render(<SyncWaveBackground isSyncing={true} />);

      // Decorative-only: it should not surface any accessible text.
      expect(screen.queryByText(/./)).not.toBeInTheDocument();
    });
  });
});
