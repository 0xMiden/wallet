import React, { FC, PropsWithChildren, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { isWasmSimdSupported } from 'lib/wasm-simd';

/** Refuses to start the wallet on a runtime its WebAssembly cannot run on, instead of crashing into the error screen. */
export const RuntimeSupportGate: FC<PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const [supported] = useState(isWasmSimdSupported);
  useUserVisibleError(supported ? null : 'runtimeUnsupportedBody', 'startup');

  if (supported) return <>{children}</>;

  return (
    <main
      data-testid="runtime-unsupported"
      className="min-h-screen bg-page text-ink flex items-center justify-center px-6 py-12 font-inter antialiased"
    >
      <section className="w-full max-w-92.5 flex flex-col items-center text-center gap-4">
        <h1 className="text-xl font-semibold">{t('runtimeUnsupportedTitle')}</h1>
        <p className="text-sm text-muted leading-relaxed">{t('runtimeUnsupportedBody')}</p>
      </section>
    </main>
  );
};
