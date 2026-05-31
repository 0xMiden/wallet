import React from 'react';

interface AgglayerMidenToEvmFormProps {
  evmAddress: string;
  midenAccount: string;
}

// TODO: wire up the Agglayer Miden→EVM flow once the integration details land.
export const AgglayerMidenToEvmForm: React.FC<AgglayerMidenToEvmFormProps> = () => (
  <div className="flex flex-col gap-3 rounded-lg border border-grey-100 bg-white px-3 py-3 text-sm">
    <span className="font-medium text-heading-gray">Bridge Miden → EVM (Agglayer)</span>
    <div className="rounded-md bg-grey-50 px-3 py-4 text-center text-xs text-grey-500">Agglayer bridge coming soon</div>
  </div>
);
