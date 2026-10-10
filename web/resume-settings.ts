import { resolveLaunchTune, softwareFamily } from '../src/shared/launch-prompt.ts';
import type { NativeSession } from '../src/shared/native-session.ts';
import type { SavedLaunch } from '../src/shared/launch-settings.ts';

export type ResumePreferences = { software?: string; model?: string; effort?: string; extraFlags?: string };
export type ResumeEdits = { sessionId?: string; native?: boolean; included?: boolean; environment?: string };

/** Preferences are Human choices, keyed by immutable agent ID, not a renameable display name. */
export function resumeSettings(base: { software: string; model: string; effort: string; extraFlags: string },
  reported: NativeSession | undefined, preferences: ResumePreferences = {}, edits: ResumeEdits = {}, saved?: SavedLaunch) {
  if (saved) {
    base = saved.settings;
    const family = softwareFamily(saved.settings.software);
    reported = ['codex', 'claude', 'cursor'].includes(family) ? { software: family as NativeSession['software'],
      sessionId: saved.sessionId, model: saved.settings.model, effort: saved.settings.effort as NativeSession['effort'] } : undefined;
    // A saved launch is authoritative over old browser defaults, but explicit edits in this sheet still win.
    preferences = { software: saved.settings.software, ...preferences };
  }
  const software = preferences.software ?? reported?.software ?? base.software;
  const sameFamily = reported !== undefined && reported.software === softwareFamily(software);
  const inherited = sameFamily && reported ? { model: reported.model, effort: reported.effort }
    : softwareFamily(software) === softwareFamily(base.software) ? base : { model: '', effort: '' };
  const tune = preferences.model === undefined ? resolveLaunchTune(inherited)
    : { model: preferences.model, effort: preferences.effort ?? '' };
  const sessionId = edits.sessionId ?? (sameFamily && reported ? reported.sessionId ?? '' : '');
  return { software, ...tune, sessionId, native: edits.native ?? Boolean(sessionId),
    extraFlags: preferences.extraFlags ?? (software === base.software ? base.extraFlags : '') };
}

export function readResumePreferences(input: unknown): Record<string, ResumePreferences> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = Object.entries(input).slice(0, 200).flatMap(([id, raw]) => {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id) || !raw || typeof raw !== 'object') return [];
    const p = Object.fromEntries(['software', 'model', 'effort', 'extraFlags'].flatMap(key => {
      const value = (raw as Record<string, unknown>)[key];
      return typeof value === 'string' && value.length <= 2000 ? [[key, value]] : [];
    }));
    return [[id, p]];
  });
  return Object.fromEntries(entries);
}
