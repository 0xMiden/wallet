export interface CrashBuildIdentity {
  target?: 'extension' | 'mobile' | 'desktop' | 'background';
  revision?: string;
  dirty?: boolean;
}

/** Build constants are validated before bypassing ordinary free-text redaction. */
export function getCrashBuildIdentity(): CrashBuildIdentity {
  const identity: CrashBuildIdentity = {};
  const target = process.env.WALLET_BUILD_TARGET;
  const revision = process.env.WALLET_BUILD_REVISION;
  const dirty = process.env.WALLET_BUILD_DIRTY;
  if (target === 'extension' || target === 'mobile' || target === 'desktop' || target === 'background') {
    identity.target = target;
  }
  if (revision !== undefined && /^[a-f0-9]{40}$/.test(revision)) identity.revision = revision;
  if (dirty === 'true' || dirty === 'false') identity.dirty = dirty === 'true';
  return identity;
}
