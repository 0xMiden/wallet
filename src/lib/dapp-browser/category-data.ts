/**
 * Category metadata for the launcher's category chip row.
 *
 * Categories are i18n'd at render time via `t(category.labelKey)`. This
 * module just owns the ordered list and the icon mapping. PR-2 ships
 * filter-by-category as a client-side filter against `FEATURED_DAPPS`.
 */

import { IconName } from 'app/icons/v2';

import type { FeaturedDappCategory } from './featured-dapps';

export interface CategoryDescriptor {
  id: FeaturedDappCategory;
  /** i18n key for the chip label */
  labelKey: string;
  icon: IconName;
}

export const CATEGORIES: CategoryDescriptor[] = [
  { id: 'defi', labelKey: 'categoryDefi', icon: IconName.Coins },
  { id: 'nft', labelKey: 'categoryNft', icon: IconName.Image },
  { id: 'tools', labelKey: 'categoryTools', icon: IconName.Hammer },
  { id: 'social', labelKey: 'categorySocial', icon: IconName.Users }
];
