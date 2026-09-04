/**
 * `projects:suggest` / `projects:declare` main-process handlers (Task 3.1, OI-3),
 * plus the `onboarding:status` read the declaration gate is built on.
 *
 * The onboarding contract these three channels implement:
 *
 *  - `projects:suggest` mines already-ingested events for the groups the user
 *    actually participates in (`@cr/ingest`'s `suggestProjects`). It is a
 *    suggestion, never a write — X-2 means only the user declares projects.
 *  - `projects:declare` is the ONLY writer, and it enforces the OI-3 minimum
 *    (`config.onboarding.minDeclaredProjects`, default `0` — declaration is
 *    optional; see the note on that config field) *before* touching the
 *    database. A rejected call leaves no row behind, so a user who mashes the
 *    button with fewer than the configured minimum selected does not end up
 *    half-onboarded.
 *  - `onboarding:status` reports what the wizard still needs. It lives here
 *    because `projectsDeclared` is this task's data, and because the home
 *    screen's briefing action is gated on it — a gate no one can read is not a
 *    gate.
 *
 * IDEMPOTENCY. `projects.name` carries no UNIQUE constraint (the PK is a fresh
 * uuid per insert), so `GraphRepo.declareProject` would happily create a second
 * row for the same name — and the renderer re-submits: the user goes back a
 * step, adds a fourth project, and declares all four. Deduplication is therefore
 * done HERE, check-before-insert against the additive, read-only
 * `GraphRepo.getProjectByName`, rather than by making `declareProject` itself an
 * upsert. Rationale: `declareProject` is the primitive "create a project", and
 * silently turning it into "create unless a same-named one exists" would change
 * behaviour under every other caller — including future ones that legitimately
 * want two distinct projects with a colliding name. Duplicates *within* one
 * request are collapsed the same way, before the first insert.
 *
 * As with the OAuth handlers: nothing throws out of an `ipcMain.handle`
 * callback. A rejection reaches the renderer as an opaque
 * "Error invoking remote method …" with a main-process stack pasted into it.
 */
import { ipcMain } from 'electron';
import type { AppConfig } from '@cr/core';
import { suggestProjects, type TokenVault } from '@cr/ingest';
import type { EventsRepo, GraphRepo } from '@cr/store';
import { preflight } from '@cr/ai';
import type {
  OkResult,
  OnboardingStatus,
  ProjectCandidate,
  ProjectSuggestions,
  Source,
} from '../preload.cjs';

/** The only project origin the POC permits (X-2); `GraphRepo` rejects anything else. */
const DECLARED_ORIGIN = 'declared';

/** Sources probed for `onboarding.sourcesConnected`, in a stable display order. */
const SOURCES: readonly Source[] = ['slack', 'gmail'];

/**
 * Upper bound on a single project name. Free text from the renderer goes
 * straight into a row that is later rendered back into the UI and into prompts;
 * an unbounded string is a cheap way to wedge both.
 */
const MAX_NAME_LENGTH = 120;

/** One declared project as `projects:list` reports it (A-2). */
export interface DeclaredProject {
  projectId: string;
  name: string;
}

export interface ProjectsHandlerDeps {
  /** Read-only source of the suggestion evidence. */
  events: EventsRepo;
  /** Where declared projects are written, and where existing ones are read. */
  graph: GraphRepo;
  /** Supplies `onboarding.minDeclaredProjects` and the Ollama endpoint/models. */
  config: AppConfig;
  /** Read to report which sources hold live credentials. */
  vault: TokenVault;
  /**
   * The `actorId` identifying the user in ingested events. Defaults to the
   * `people.is_self` row when one exists; absent identity resolution yields no
   * suggestions rather than wrong ones.
   */
  selfPersonId?: string;
}

/**
 * Narrow the renderer-supplied `{ names }` argument.
 *
 * The preload already shape-checks this; that check is a convenience gate, not a
 * trust boundary — a compromised renderer controls what it sends.
 *
 * @returns Trimmed names, or `null` when the argument is not a well-formed list
 *   of non-empty, reasonably-sized strings.
 */
export function parseDeclareNames(arg: unknown): string[] | null {
  const names: unknown = (arg as { names?: unknown } | null)?.names;
  if (!Array.isArray(names)) return null;

  const cleaned: string[] = [];
  for (const entry of names) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed === '' || trimmed.length > MAX_NAME_LENGTH) return null;
    cleaned.push(trimmed);
  }
  return cleaned;
}

/**
 * Collapse names that differ only by case or surrounding whitespace, keeping the
 * first spelling the user typed.
 *
 * This runs BEFORE the OI-3 minimum is checked, on purpose: `['api','API','Api']`
 * has `length === 3` but declares exactly one project, and accepting it would
 * satisfy the letter of the minimum while defeating the point of it.
 */
export function distinctNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Declare every name that does not already exist, and report what happened.
 *
 * Extracted from the handler so the handler is nothing but validation plus a
 * try/catch. Not wrapped in a transaction: `GraphRepo` owns its own statements
 * and exposes no handle, and the idempotency above makes a retry after a partial
 * failure safe — re-declaring the names that landed is a no-op.
 */
function declareAll(graph: GraphRepo, names: readonly string[]): { created: number } {
  let created = 0;
  for (const name of names) {
    // Check-before-insert: see the module note on why `declareProject` is not
    // itself an upsert.
    if (graph.getProjectByName(name) !== undefined) continue;
    graph.declareProject({ name, origin: DECLARED_ORIGIN });
    created += 1;
  }
  return { created };
}

/** Which sources currently hold a usable, non-revoked credential. */
async function connectedSources(vault: TokenVault): Promise<Source[]> {
  const connected: Source[] = [];
  for (const source of SOURCES) {
    try {
      if ((await vault.load(source)) !== undefined) connected.push(source);
    } catch {
      // A vault that cannot be decrypted is reported as "not connected", which
      // is what the user has to act on anyway.
    }
  }
  return connected;
}

/**
 * Register the two project channels plus `onboarding:status`.
 *
 * Safe to call before any window exists — none of the three needs a
 * `BrowserWindow`.
 */
export function registerProjectsHandlers(deps: ProjectsHandlerDeps): void {
  ipcMain.handle('projects:suggest', async (): Promise<ProjectSuggestions> => {
    try {
      // Identity resolution is a later task; until `people.is_self` is
      // populated this is `''`, and `suggestProjects` returns `[]` rather than
      // ranking unattributed events as the user's own work. The UI's free-text
      // path is the documented fallback (OI-3).
      const selfPersonId = deps.selfPersonId ?? deps.graph.getSelf()?.personId ?? '';
      const candidates: ProjectCandidate[] = suggestProjects(deps.events, selfPersonId);
      return { candidates };
    } catch (error) {
      // An empty suggestion list is a supported state; a rejected invoke is not.
      console.error('[projects] suggest failed', error);
      return { candidates: [] };
    }
  });

  /**
   * Declared projects, **with their ids** (A-2).
   *
   * `onboarding:status` already reports declared project *names*, which is all a
   * status line needs. The channel-tagging control needs to write
   * `slack_selected_channels.project_id`, and a name is not a key — two projects
   * may legitimately share one after a rename, and the FK wants the id. Hence a
   * separate channel rather than widening the status payload, which is read on
   * every page load by callers that do not need this.
   */
  ipcMain.handle('projects:list', async (): Promise<DeclaredProject[]> => {
    try {
      return deps.graph
        .listProjects()
        .map((project) => ({ projectId: project.projectId, name: project.name }));
    } catch (error) {
      // An empty list degrades the tagging control to "no projects yet", which
      // it already renders; a rejected invoke would break the settings page.
      console.error('[projects] list failed', error);
      return [];
    }
  });

  ipcMain.handle('projects:declare', async (_event, arg: unknown): Promise<OkResult> => {
    const parsed = parseDeclareNames(arg);
    if (parsed === null) return { ok: false, reason: 'invalid_names' };

    const names = distinctNames(parsed);
    const minimum = deps.config.onboarding.minDeclaredProjects;
    if (names.length < minimum) {
      // OI-3 — rejected before any write, so nothing is persisted.
      return { ok: false, reason: `too_few_projects: at least ${minimum} required` };
    }

    try {
      declareAll(deps.graph, names);
      return { ok: true };
    } catch (error) {
      console.error('[projects] declare failed', error);
      return { ok: false, reason: 'internal_error' };
    }
  });

  ipcMain.handle('onboarding:status', async (): Promise<OnboardingStatus> => {
    const projectsDeclared = deps.graph.listProjects().map((project) => project.name);
    const sourcesConnected = await connectedSources(deps.vault);

    // Probed live rather than cached from the startup gate: Ollama can be
    // stopped after launch, and a status screen that keeps claiming "ready"
    // sends the user looking for the fault everywhere except where it is.
    let ollamaReady = false;
    try {
      const result = await preflight(
        deps.config.model.ollamaBaseUrl,
        deps.config.model.chat,
        deps.config.model.embed,
      );
      ollamaReady = result.ok;
    } catch {
      ollamaReady = false;
    }

    return { sourcesConnected, projectsDeclared, ollamaReady };
  });
}
