/**
 * Public type surface of the desktop app.
 *
 * Type-only re-exports so the renderer (`apps/ui`) can type `window.contextRestorer`
 * against the same definitions the preload implements, without importing the preload
 * module itself (which calls `contextBridge.exposeInMainWorld` on load).
 *
 * The Electron entry point is `dist/main.js`, not this file.
 */
export type {
  BriefingChunk,
  BriefingDone,
  BriefingHandle,
  BriefingMode,
  BriefingWindow,
  Citation,
  ContextRestorerBridge,
  Drilldown,
  DrilldownEvent,
  FeedbackSubmission,
  FeedbackVerdict,
  OkResult,
  OnboardingStatus,
  PendingItem,
  ProjectCandidate,
  ProjectSuggestions,
  Source,
  SourceHealth,
  Unsubscribe,
} from './preload.cjs';
