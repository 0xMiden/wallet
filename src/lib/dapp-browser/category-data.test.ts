import { IconName } from 'app/icons/v2';

import { CATEGORIES, CategoryDescriptor } from './category-data';
import { FEATURED_DAPPS, FeaturedDappCategory } from './featured-dapps';

describe('dApp launcher category-data', () => {
  it('exposes exactly the four launcher categories in a stable order', () => {
    expect(Array.isArray(CATEGORIES)).toBe(true);
    expect(CATEGORIES.map(c => c.id)).toEqual(['defi', 'nft', 'tools', 'social']);
  });

  it('maps each category to its expected label key and icon', () => {
    const expected: CategoryDescriptor[] = [
      { id: 'defi', labelKey: 'categoryDefi', icon: IconName.Coins },
      { id: 'nft', labelKey: 'categoryNft', icon: IconName.Image },
      { id: 'tools', labelKey: 'categoryTools', icon: IconName.Hammer },
      { id: 'social', labelKey: 'categorySocial', icon: IconName.Users }
    ];
    expect(CATEGORIES).toEqual(expected);
  });

  it('gives every descriptor a non-empty labelKey and a real IconName value', () => {
    const iconValues = new Set(Object.values(IconName));
    for (const category of CATEGORIES) {
      expect(typeof category.id).toBe('string');
      expect(category.labelKey.length).toBeGreaterThan(0);
      // labelKey convention: "category" + CapitalizedId.
      const capitalized = category.id.charAt(0).toUpperCase() + category.id.slice(1);
      expect(category.labelKey).toBe(`category${capitalized}`);
      // icon must be a member of the IconName enum, not an arbitrary string.
      expect(iconValues.has(category.icon)).toBe(true);
    }
  });

  it('has no duplicate category ids, label keys, or icons', () => {
    const ids = CATEGORIES.map(c => c.id);
    const labelKeys = CATEGORIES.map(c => c.labelKey);
    const icons = CATEGORIES.map(c => c.icon);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labelKeys).size).toBe(labelKeys.length);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('only references category ids that are valid FeaturedDappCategory values', () => {
    // The FeaturedDappCategory string-literal union. Kept in sync with the
    // type in featured-dapps.ts; every declared chip id must be one of these.
    const validCategories = new Set<FeaturedDappCategory>(['defi', 'nft', 'tools', 'social']);
    for (const category of CATEGORIES) {
      expect(validCategories.has(category.id)).toBe(true);
    }
  });

  it('renders a chip for every category the featured dApp catalogue actually uses', () => {
    // No dApp in the catalogue may sit in a category the chip row does not
    // render, otherwise it would be unreachable via category filtering.
    // (The reverse is allowed: a chip may currently hold zero dApps.)
    const usedByCatalogue = new Set<FeaturedDappCategory>(FEATURED_DAPPS.map(d => d.category));
    const declared = new Set<FeaturedDappCategory>(CATEGORIES.map(c => c.id));
    for (const used of usedByCatalogue) {
      expect(declared.has(used)).toBe(true);
    }
  });
});
