/**
 * `model:get` / `model:setChat` — the chat-model picker (Settings page).
 *
 * Exists because a machine without a GPU and with little free RAM can take
 * MINUTES to produce a single token from a 14B-class model (measured directly
 * against this project's own Ollama instance) — the model configured in
 * `config/default.json` is not a safe fit for every machine this app runs on,
 * and there was previously no way to change it short of hand-editing that file.
 *
 * `model:get` reports the CURRENTLY EFFECTIVE chat model (the persisted
 * override if one exists, else the config file's default) plus every model
 * Ollama currently reports as installed, so the settings UI can only ever
 * offer a model the user has actually pulled — never a name that would fail
 * `preflight` if selected.
 *
 * `model:setChat` only PERSISTS the choice; it does not apply it live. Every
 * consumer of `config.model.chat` (`BriefingGenerator`, the template renderer,
 * the schedule runner, the `onboarding:status` preflight probe) captures that
 * value once, at construction time, in `main.ts` — threading a mutable
 * reference through all of them for a setting nobody changes mid-session would
 * be a bad trade. `main.ts`'s `runPreflightGate()` reads the persisted override
 * and applies it to `config.model.chat` BEFORE any of those are constructed, on
 * the NEXT launch, which is why the settings UI must say so.
 */
import { ipcMain } from 'electron';
import { listInstalledModels } from '@cr/ai';
import type { OkResult } from '../preload.cjs';

/** Invoke channel reporting the effective chat model and what is installed. */
export const MODEL_GET_CHANNEL = 'model:get';

/** Invoke channel persisting a new chat-model choice (applied on next launch). */
export const MODEL_SET_CHAT_CHANNEL = 'model:setChat';

/** The `app_settings` key the chat-model override is stored under. */
export const CHAT_MODEL_SETTING_KEY = 'model.chat';

/**
 * The slice of `AppSettingsRepo` this module uses.
 *
 * Structural, so the real repo satisfies it with no adapter and a test can
 * pass a hand-rolled store.
 */
export interface ModelSettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ModelSettingsDeps {
  /** `AppSettingsRepo` in production. */
  settings: ModelSettingsStore;
  /** `config.model.chat` as loaded from `config/default.json`, BEFORE any override is applied. */
  defaultChatModel: string;
  /** `config.model.ollamaBaseUrl`, for the live `/api/tags` probe. */
  ollamaBaseUrl: string;
}

/** `model:get` result. */
export interface ModelInfo {
  /** The override if one is persisted, else {@link ModelInfo.defaultChat}. */
  chat: string;
  /** The config file's own default, so the UI can label it as such. */
  defaultChat: string;
  /** Every model Ollama currently reports as installed. Empty if Ollama is unreachable. */
  available: string[];
}

/**
 * The whole of `model:get`. Never throws — an unreachable Ollama degrades to
 * an empty `available` list (`listInstalledModels` already never throws),
 * which the settings page renders as "connect Ollama to see available models"
 * rather than a failed load.
 */
export async function getModelInfo(deps: ModelSettingsDeps): Promise<ModelInfo> {
  const override = deps.settings.get(CHAT_MODEL_SETTING_KEY);
  const available = await listInstalledModels(deps.ollamaBaseUrl);
  return {
    chat: override !== null && override !== '' ? override : deps.defaultChatModel,
    defaultChat: deps.defaultChatModel,
    available,
  };
}

/**
 * Re-validate the renderer-supplied model name. The preload checks too, but a
 * compromised renderer controls what it sends, so the preload's check is a
 * convenience gate and this one is the trust boundary.
 */
export function parseSetChatArg(arg: unknown): string | null {
  const model = (arg as { model?: unknown } | null)?.model;
  if (typeof model !== 'string' || model.trim() === '') return null;
  return model;
}

/**
 * The whole of `model:setChat`: validate, persist, acknowledge. Never throws —
 * a storage fault comes back as `{ ok: false, reason }`, the same contract
 * every other handler in this codebase uses.
 */
export function setChatModel(arg: unknown, deps: ModelSettingsDeps): OkResult {
  const model = parseSetChatArg(arg);
  if (model === null) return { ok: false, reason: 'invalid_model' };

  try {
    deps.settings.set(CHAT_MODEL_SETTING_KEY, model);
    return { ok: true };
  } catch (error) {
    console.error('[model] setChat failed', error);
    return { ok: false, reason: 'internal_error' };
  }
}

/**
 * Register both channels. Safe to call before any window exists — neither
 * handler needs a `BrowserWindow`.
 */
export function registerModelSettingsHandlers(deps: ModelSettingsDeps): void {
  ipcMain.handle(MODEL_GET_CHANNEL, async (): Promise<ModelInfo> => {
    try {
      return await getModelInfo(deps);
    } catch (error) {
      // A failed read must not surface as a rejected invoke: degrading to the
      // config default with no available list is still something the UI can
      // render, where a thrown error is not.
      console.error('[model] get failed', error);
      return { chat: deps.defaultChatModel, defaultChat: deps.defaultChatModel, available: [] };
    }
  });

  ipcMain.handle(MODEL_SET_CHAT_CHANNEL, (_event, arg: unknown): OkResult =>
    setChatModel(arg, deps),
  );
}
