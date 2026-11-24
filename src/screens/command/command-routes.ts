export type CommandAction = 'send' | 'receive' | 'swap' | 'earn' | 'bridge';

export type CommandRoute =
  | { kind: 'dashboard' }
  | { kind: 'flow'; action: CommandAction }
  | { kind: 'operation'; id: string };

const actionRoutes: Record<string, CommandAction> = {
  '/send': 'send',
  '/send/review': 'send',
  '/receive': 'receive',
  '/swap': 'swap',
  '/earn': 'earn',
  '/earn/positions': 'earn',
  '/bridge/deposit': 'bridge'
};

const earnRoutes = [
  /^\/earn\/vaults\/[^/]+(?:\/deposit(?:\/review)?)?$/,
  /^\/earn\/positions\/[^/]+(?:\/withdraw(?:\/review)?)?$/
];

const operationRoutes = [
  /^\/history-details\/([^/]+)$/,
  /^\/generating-transaction(?:-full)?\/([^/]+)$/,
  /^\/earn\/withdraw-status\/([^/]+)$/
];

export function resolveCommandRoute(pathname: string): CommandRoute | null {
  if (pathname === '/') return { kind: 'dashboard' };
  const action = actionRoutes[pathname];
  if (action) return { kind: 'flow', action };
  if (earnRoutes.some(route => route.test(pathname))) return { kind: 'flow', action: 'earn' };
  for (const route of operationRoutes) {
    const match = route.exec(pathname);
    if (match?.[1]) return { kind: 'operation', id: match[1] };
  }
  return null;
}
