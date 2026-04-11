import { GOOGLE_DRIVE_BACKUP_FILENAME } from './constants';
import { getGoogleAuthToken, GoogleAuthResult } from './google-drive-auth';
import { CloudAuthState, CloudProvider } from './types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export class GoogleDriveProvider implements CloudProvider {
  readonly providerId = 'google-drive';
  readonly displayName = 'Google Drive';

  private auth: GoogleAuthResult | null = null;
  private cachedFileId: string | null = null;

  /**
   * @param accessToken Pre-authenticated token (for backend use).
   *   When omitted, call authenticate() first (frontend use).
   */
  constructor(accessToken?: string) {
    if (accessToken) {
      this.auth = { accessToken, expiresAt: Date.now() + 3600 * 1000 };
    }
  }

  private async getAccessToken(): Promise<string> {
    if (!this.auth || Date.now() >= this.auth.expiresAt) {
      this.auth = await getGoogleAuthToken();
    }
    return this.auth.accessToken;
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  // ---- CloudProvider interface ----

  async authenticate(): Promise<CloudAuthState> {
    this.auth = await getGoogleAuthToken();
    return {
      isAuthenticated: true,
      provider: this.providerId
    };
  }

  async getAuthState(): Promise<CloudAuthState> {
    if (!this.auth || Date.now() >= this.auth.expiresAt) {
      return { isAuthenticated: false, provider: this.providerId };
    }
    return {
      isAuthenticated: true,
      provider: this.providerId
    };
  }

  async signOut(): Promise<void> {
    if (this.auth) {
      try {
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${this.auth.accessToken}`, {
          method: 'POST'
        });
      } catch {
        // Best effort revocation
      }
    }
    this.auth = null;
    this.cachedFileId = null;
  }

  async write(data: Uint8Array): Promise<void> {
    const token = await this.getAccessToken();
    const fileId = await this.findFileId(token);

    if (fileId) {
      await this.updateFile(token, fileId, data);
    } else {
      this.cachedFileId = await this.createFile(token, data);
    }
  }

  async read(): Promise<Uint8Array | null> {
    const token = await this.getAccessToken();
    const fileId = await this.findFileId(token);
    if (!fileId) return null;

    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: this.headers(token)
    });

    if (!res.ok) {
      throw new Error(`Failed to download backup: ${res.status} ${res.statusText}`);
    }

    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(): Promise<void> {
    const token = await this.getAccessToken();
    const fileId = await this.findFileId(token);
    if (!fileId) return;

    const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
      method: 'DELETE',
      headers: this.headers(token)
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete backup: ${res.status} ${res.statusText}`);
    }

    this.cachedFileId = null;
  }

  async exists(): Promise<boolean> {
    const token = await this.getAccessToken();
    return (await this.findFileId(token)) !== null;
  }

  // ---- Internal Drive API helpers ----

  private async findFileId(token: string): Promise<string | null> {
    if (this.cachedFileId) return this.cachedFileId;

    const query = `name='${GOOGLE_DRIVE_BACKUP_FILENAME}' and trashed=false`;
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: query,
      fields: 'files(id)',
      pageSize: '1'
    });

    const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
      headers: this.headers(token)
    });

    if (!res.ok) {
      throw new Error(`Failed to search Drive: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    this.cachedFileId = data.files?.[0]?.id ?? null;
    return this.cachedFileId;
  }

  private async createFile(token: string, data: Uint8Array): Promise<string> {
    const metadata = {
      name: GOOGLE_DRIVE_BACKUP_FILENAME,
      parents: ['appDataFolder']
    };

    const boundary = '---miden-backup-boundary';
    const metadataPart = JSON.stringify(metadata);

    const encoder = new TextEncoder();
    const preamble = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n` +
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const epilogue = encoder.encode(`\r\n--${boundary}--`);

    const body = new Uint8Array(preamble.byteLength + data.byteLength + epilogue.byteLength);
    body.set(preamble, 0);
    body.set(data, preamble.byteLength);
    body.set(epilogue, preamble.byteLength + data.byteLength);

    const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        ...this.headers(token),
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });

    if (!res.ok) {
      throw new Error(`Failed to create backup: ${res.status} ${res.statusText}`);
    }

    const result = await res.json();
    return result.id;
  }

  private async updateFile(token: string, fileId: string, data: Uint8Array): Promise<void> {
    const res = await fetch(`${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        ...this.headers(token),
        'Content-Type': 'application/octet-stream'
      },
      body: data as BodyInit
    });

    if (!res.ok) {
      throw new Error(`Failed to update backup: ${res.status} ${res.statusText}`);
    }
  }
}
