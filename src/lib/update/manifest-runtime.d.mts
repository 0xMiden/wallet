export type UpdatePlatform = 'chrome' | 'android' | 'ios' | 'desktop';
/** The platforms a catalog entry may name: those with an authoritative source. */
export type UpdateManifestPlatform = 'chrome' | 'android' | 'ios';
export type UpdateUrgency = 'normal' | 'important' | 'critical';

export interface UpdateReleaseMetadata {
  version: string;
  summary: string;
  urgency: UpdateUrgency;
  platforms: UpdateManifestPlatform[];
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
