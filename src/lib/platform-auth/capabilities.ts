export async function getPlatformUnlockSupport(): Promise<boolean> {
  if (process.env.TARGET_BROWSER !== 'chrome' || typeof navigator === 'undefined') return false;
  const data: unknown = Reflect.get(navigator, 'userAgentData');
  if (!data || typeof data !== 'object') return false;
  const brands: unknown = Reflect.get(data, 'brands');
  if (
    !Array.isArray(brands) ||
    !brands.some((brand: unknown) => {
      if (!brand || typeof brand !== 'object') return false;
      const name: unknown = Reflect.get(brand, 'brand');
      const version: unknown = Reflect.get(brand, 'version');
      return (
        (name === 'Chromium' || name === 'Google Chrome') &&
        typeof version === 'string' &&
        String(Number(version)) === version &&
        Number.isSafeInteger(Number(version)) &&
        Number(version) >= 140
      );
    })
  )
    return false;
  const getValues: unknown = Reflect.get(data, 'getHighEntropyValues');
  if (typeof getValues !== 'function') return false;
  try {
    const values: unknown = await getValues.call(data, ['platformVersion']);
    if (!values || typeof values !== 'object') return false;
    const platform: unknown = Reflect.get(values, 'platform');
    const version: unknown = Reflect.get(values, 'platformVersion');
    if (typeof version !== 'string' || version.trim() !== version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
    const major = Number(version.split('.')[0]);
    return (platform === 'macOS' && major >= 15) || (platform === 'Windows' && major >= 13);
  } catch {
    return false;
  }
}
