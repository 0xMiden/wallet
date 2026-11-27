import { useCallback, useLayoutEffect, useRef } from 'react';

import { useAppEnv } from 'app/env';
import { isMobile } from 'lib/platform';
import { reportTelemetryEvent } from 'lib/telemetry/report-flow';
import { touchRun } from 'lib/telemetry/run';
import {
  isDiscoveryFeature,
  TELEMETRY_DISCOVERY_FEATURES,
  TelemetryDiscoveryAction,
  TelemetryEntryPoint,
  TelemetryFeature,
  TelemetrySurface
} from 'lib/telemetry/types';
import { ROUTE_DWELL_MS } from 'lib/telemetry/use-route-dwell';

const HIDE_ATTRIBUTE: Partial<Record<TelemetryEntryPoint, string>> = {
  bottom_nav: 'data-hide-navbar',
  home_actions: 'data-hide-home-actions'
};

// A retained control and its remount should count once in the same foreground opportunity.
const exposed = new Set<string>();

export function useFeatureDiscovery<T extends HTMLElement>(
  entryPoint: TelemetryEntryPoint,
  active: boolean,
  unavailable?: TelemetryFeature
) {
  const ref = useRef<T>(null);
  const { popup, sidePanel } = useAppEnv();
  const surface: TelemetrySurface = isMobile() ? 'app' : popup ? 'popup' : sidePanel ? 'side_panel' : 'full_page';
  const hideAttribute = HIDE_ATTRIBUTE[entryPoint];

  const report = useCallback(
    (feature: TelemetryFeature, discoveryAction: TelemetryDiscoveryAction) => {
      reportTelemetryEvent({ phase: 'discovery', feature, entryPoint, discoveryAction, surface, runId: touchRun() });
    },
    [entryPoint, surface]
  );

  const visible = useCallback(
    () => document.visibilityState !== 'hidden' && (!hideAttribute || !document.body.hasAttribute(hideAttribute)),
    [hideAttribute]
  );

  useLayoutEffect(() => {
    const element = ref.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let intersecting = false;
    let pagePresent = true;

    function update() {
      clearTimeout(timer);
      if (!pagePresent || !intersecting || !visible()) return;
      timer = setTimeout(() => {
        if (!pagePresent || !intersecting || !visible() || !element?.isConnected) return;
        for (const feature of TELEMETRY_DISCOVERY_FEATURES[entryPoint]) {
          const key = `${entryPoint}:${feature}`;
          if (feature === unavailable || exposed.has(key)) continue;
          exposed.add(key);
          report(feature, 'exposed');
        }
      }, ROUTE_DWELL_MS);
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') exposed.clear();
      update();
    }

    function onPageHide() {
      pagePresent = false;
      exposed.clear();
      update();
    }

    function onPageShow() {
      pagePresent = true;
      update();
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    let viewport: IntersectionObserver | undefined;
    let visibility: MutationObserver | undefined;
    if (active && element && typeof IntersectionObserver !== 'undefined') {
      viewport = new IntersectionObserver(
        entries => {
          const last = entries[entries.length - 1];
          intersecting = last?.isIntersecting === true && last.intersectionRatio >= 1;
          update();
        },
        { threshold: 1 }
      );
      viewport.observe(element);
      if (hideAttribute) {
        visibility = new MutationObserver(update);
        visibility.observe(document.body, { attributes: true, attributeFilter: [hideAttribute] });
      }
    }

    return () => {
      pagePresent = false;
      clearTimeout(timer);
      viewport?.disconnect();
      visibility?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [active, entryPoint, hideAttribute, report, unavailable, visible]);

  function select(feature: string) {
    if (active && visible() && feature !== unavailable && isDiscoveryFeature(entryPoint, feature)) {
      report(feature, 'selected');
    }
  }

  return { ref, select };
}
