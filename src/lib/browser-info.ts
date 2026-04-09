const secureBrowserVersions: Record<string, number> = {
  Chrome: 93,
  Firefox: 88,
  IE: 11,
  Edge: 16,
  Opera: 72,
  Safari: 12
};

const browserInfo = (() => {
  const ua = navigator.userAgent;
  const M = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) ?? [];
  const engine = M[1] ?? '';
  const engineVersion = M[2] ?? '';

  if (/trident/i.test(engine)) {
    const tem = /\brv[ :]+(\d+)/g.exec(ua);
    return { name: 'IE', version: tem?.[1] ?? '' };
  }

  if (engine === 'Chrome') {
    const tem = ua.match(/\b(OPR|Edge)\/(\d+)/);
    if (tem?.[1] && tem[2]) {
      return { name: tem[1].replace('OPR', 'Opera'), version: tem[2] };
    }
  }

  let name: string;
  let version: string;
  if (engineVersion) {
    name = engine;
    version = engineVersion;
  } else {
    name = navigator.appName;
    version = navigator.appVersion;
  }

  const versionMatch = ua.match(/version\/(\d+)/i);
  if (versionMatch?.[1]) {
    version = versionMatch[1];
  }

  return { name, version };
})();

export const isSafeBrowserVersion = (() => {
  const minVersion = secureBrowserVersions[browserInfo.name];
  if (minVersion === undefined) return false;
  return parseInt(browserInfo.version) >= minVersion;
})();
