import React from 'react';
// Harness-only native back/navigation boundaries. Real drawer, carousel and cards are rendered.
export const useMobileBackHandler = () => {};
export const navigate = (to: string) => {
  document.body.dataset.navigationTo = to;
};
export const Link: React.FC<React.PropsWithChildren<{ to?: string; className?: string }>> = ({
  children,
  to,
  className
}) => (
  <a href={to} className={className}>
    {children}
  </a>
);
