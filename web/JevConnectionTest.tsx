import { useEffect, useRef, useState } from 'react';
import { JEV_DIAGNOSTIC_MESSAGES, type JevDiagnosticCode } from '../src/shared/jev-diagnostics.ts';
import { jevDiagnosticsApi } from './jev-diagnostics-api.ts';

export function JevConnectionTest({ savedSettings, disabled }: { savedSettings: { model?: string } | null; disabled: boolean }) {
  const active = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<JevDiagnosticCode | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    active.current?.abort();
    active.current = null;
    setRunning(false);
    setResult(null);
    setError(false);
    // Results are ephemeral. A different tab or local editor may have changed the saved settings.
    const clear = () => {
      active.current?.abort();
      active.current = null;
      setRunning(false);
      setResult(null);
      setError(false);
    };
    window.addEventListener('focus', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      active.current?.abort();
      active.current = null;
      window.removeEventListener('focus', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [savedSettings, disabled]);

  async function run() {
    if (!savedSettings || disabled || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setResult(null);
    setError(false);
    try {
      // GET reads an opaque local revision; only the explicit POST can contact TypeSafe.
      const before = await jevDiagnosticsApi.state(controller.signal);
      if (controller.signal.aborted) return;
      const tested = await jevDiagnosticsApi.test(before.revision, controller.signal);
      if (controller.signal.aborted) return;
      const after = await jevDiagnosticsApi.state(controller.signal);
      if (active.current !== controller || controller.signal.aborted) return;
      setResult(before.revision === tested.revision && tested.revision === after.revision
        ? tested.code : 'settings_changed');
    } catch {
      if (active.current === controller && !controller.signal.aborted) setError(true);
    } finally {
      if (active.current === controller) { active.current = null; setRunning(false); }
    }
  }

  return <section aria-label="Jev connection test">
    <p className="help-p">Test the current saved settings{savedSettings?.model ? <> (model <code>{savedSettings.model}</code>)</> : null} with one small synthetic request to TypeSafe. This can consume provider usage. No project data is sent and no work, topology or locks are changed.</p>
    <button type="button" disabled={!savedSettings || disabled || running} onClick={() => { void run(); }}>
      {running ? 'Testing Jev…' : 'Test Jev connection'}
    </button>
    {running && <button type="button" onClick={() => {
      active.current?.abort();
      active.current = null;
      setRunning(false);
      setResult('cancelled');
    }}>Cancel test</button>}
    {disabled && savedSettings && <p className="help-p">Save pending changes before testing.</p>}
    <p className="help-p" role="status" aria-live="polite">{result ? JEV_DIAGNOSTIC_MESSAGES[result] : ''}</p>
    {error && <p className="err" role="alert">Could not complete the local connection test. No automatic retry was made.</p>}
  </section>;
}
