export type UpdatePlatform = 'chrome' | 'android' | 'ios' | 'desktop';
export type UpdateUrgency = 'normal' | 'important' | 'critical';

export interface UpdatePlatformMetadata {
  version: string;
  versionCode?: number;
}

export interface UpdateReleaseMetadata {
  version: string;
  summary: string;
  urgency: UpdateUrgency;
  platforms: Partial<Record<UpdatePlatform, UpdatePlatformMetadata>>;
}

export interface UpdateManifest {
  schemaVersion: 1;
  releases: UpdateReleaseMetadata[];
}

export interface SelectedUpdateMetadata {
  version: string;
  summary: string;
  urgency: UpdateUrgency;
}

export function parseUpdateManifest(value: unknown): UpdateManifest;
export function validateUpdateManifest(value: unknown): UpdateManifest;
export function selectUpdateMetadata(
  manifest: UpdateManifest,
  platform: UpdatePlatform,
  availableVersion: string
): SelectedUpdateMetadata | null;
