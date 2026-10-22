// Harness-only wallet-history boundary; the actual Coins header is rendered.
export const useBackWithFallback = () => () => {
  document.body.dataset.backToArcade = 'true';
};
