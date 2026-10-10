import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResumePreferences, resumeSettings } from './resume-settings.ts';
import type { SavedLaunch } from '../src/shared/launch-settings.ts';

const base = { software: 'codex', model: 'codex-model', effort: 'high', extraFlags: '--search' };
const reported = { software: 'claude' as const, model: 'claude-model', effort: 'xhigh' as const,
  sessionId: '67d735d1-9e33-4a61-9645-a931afc97f2b' };
test('each seat restores its reported provider/model and native ID independently of batch defaults', () => {
  assert.deepEqual(resumeSettings(base, reported), { ...reported, native: true, extraFlags: '' });
  assert.deepEqual(resumeSettings(base, undefined), { ...base, sessionId: '', native: false });
  assert.equal(resumeSettings(base, reported, { model: '', effort: '' }).model, '', 'explicit default is not inheritance');
});
test('switching provider never reuses its native session or model; Human may supply an exact different ID', () => {
  const changed = resumeSettings(base, reported, { software: 'codex', model: '', effort: '' });
  assert.equal(changed.native, false);
  assert.equal(changed.sessionId, '');
  assert.equal(changed.model, '');
  assert.equal(resumeSettings(base, reported, {}, { native: false }).native, false);
  assert.equal(resumeSettings(base, reported, {}, { sessionId: 'manual', native: true }).sessionId, 'manual');
});
test('only bounded launch preferences persist, not environment, transcript IDs or prototype fields', () => {
  assert.deepEqual(readResumePreferences(JSON.parse('{"__proto__":{"software":"bad"},"agent-1":{"software":"claude","sessionId":"secret","environment":"private","model":"m"}}')),
    { 'agent-1': { software: 'claude', model: 'm' } });
  assert.deepEqual(readResumePreferences([]), {});
  assert.deepEqual(readResumePreferences({ a: { software: 'x'.repeat(2001), effort: null } }), { a: {} });
});

test('server-saved launch restores the selected alias, model, effort and flags rather than common defaults', () => {
  const saved: SavedLaunch = { settings: { ...base, software: 'claude-work', model: 'opus-fixture', effort: 'xhigh',
    extraFlags: '--verbose', workspacePath: '/work/original', cdWorktree: true, passProject: true, adoptUntrusted: true,
    role: 'brain', seniority: null, focus: 'coord', environment: { CLAUDE_CONFIG_DIR: '/profiles/work' } },
    sessionId: reported.sessionId, captured: true };
  assert.deepEqual(resumeSettings(base, undefined, {}, {}, saved), { software: 'claude-work', model: 'opus-fixture',
    effort: 'xhigh', extraFlags: '--verbose', sessionId: reported.sessionId, native: true });
  assert.equal(resumeSettings(base, undefined, { model: 'sonnet-fixture', effort: 'low' }, {}, saved).model, 'sonnet-fixture');
});
