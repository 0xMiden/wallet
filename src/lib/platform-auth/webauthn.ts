export async function createPlatformCredential(
  previousCredentialId: string | null,
  onCreated: (id: string, prfSalt: string, backupEligible: boolean) => Promise<void>
): Promise<{ credentialId: string; prfSecret: string }> {
  throw new Error('Platform authentication unavailable');
}

export async function getPlatformCredential(
  credentialId: string, prfSalt: string
): Promise<{ credentialId: string; prfSecret: string }> {
  throw new Error('Platform authentication unavailable');
}

export async function signalUnknownPlatformCredential(credentialId: string): Promise<void> {
  throw new Error('Platform authentication unavailable');
}
