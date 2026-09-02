/**
 * Typed accessor for the Electron preload bridge.
 *
 * Component code should always call `getBridge()` instead of reading
 * `window.contextRestorer` directly: this keeps the failure mode explicit when
 * the UI is served outside Electron (e.g. `next dev` in a plain browser, or a
 * preload script that failed to load), rather than throwing an opaque
 * "cannot read properties of undefined" deep inside a render.
 */

import type { ContextRestorerBridge } from '../types/bridge';

export type {
  BriefingCadence,
  BriefingDone,
  BriefingHandle,
  BriefingMetric,
  BriefingMode,
  BriefingScheduleInput,
  BriefingScheduleResult,
  BriefingScheduleView,
  BriefingWindow,
  CaughtUpResult,
  Citation,
  ClaimChunk,
  ContextRestorerBridge,
  DrillDown,
  DrilldownEvent,
  FeedbackInput,
  LocalMetrics,
  MetricCount,
  MetricDuration,
  OkResult,
  OnboardingStatus,
  PendingItemView,
  ProjectCandidate,
  ProjectSuggestions,
  SourceHealth,
  SourceId,
  Unsubscribe,
} from '../types/bridge';

const MISSING_BRIDGE_MESSAGE =
  'window.contextRestorer is unavailable. The Context Restorer UI must run ' +
  'inside the Electron shell (which injects the preload bridge); it cannot ' +
  'talk to the main process from a plain browser or during SSR/static export.';

/** True when the preload bridge is present on `window`. */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && window.contextRestorer != null;
}

/**
 * Returns the preload bridge.
 *
 * @throws {Error} If called during SSR/static export or outside Electron.
 */
export function getBridge(): ContextRestorerBridge {
  if (typeof window === 'undefined') {
    throw new Error(MISSING_BRIDGE_MESSAGE);
  }

  const bridge: ContextRestorerBridge | undefined = window.contextRestorer;
  if (bridge == null) {
    throw new Error(MISSING_BRIDGE_MESSAGE);
  }

  return bridge;
}
