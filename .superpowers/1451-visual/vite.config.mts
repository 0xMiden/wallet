import { resolve } from 'node:path';

import base from '../../playwright/visual/one-click/vite.config.mts';

const resolveMock = resolve(import.meta.dirname, 'mocks.ts');
const baseAliases = base.resolve?.alias;
if (!Array.isArray(baseAliases)) throw new Error('Expected aliases from the wallet visual fixture');

export default {
  ...base,
  root: import.meta.dirname,
  resolve: {
    ...base.resolve,
    alias: [
      { find: /^lib\/store$/, replacement: resolveMock },
      { find: /^app\/hooks\/useNativeFeeFaucetId$/, replacement: resolveMock },
      ...baseAliases
    ]
  },
  server: { ...base.server, port: 5197 }
};
