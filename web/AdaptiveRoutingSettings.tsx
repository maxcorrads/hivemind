import { useEffect, useState } from "react";
import { api, type AdaptiveRoutingSettings } from "./api.ts";

export function AdaptiveRoutingSettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AdaptiveRoutingSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.adaptiveRouting()
      .then(value => {
        if (!active) return;
        setSettings(value);
        setEnabled(value.enabled);
      })
      .catch(err => { if (active) setError(String(err.message || err)); });
    return () => { active = false; };
  }, []);

  const canSave = Boolean(settings) && !busy && (!enabled || settings!.apiKeySet || apiKey.trim().length > 0);

  return (
    <div className="modal" onClick={onClose}>
      <form
        className="sheet"
        onClick={e => e.stopPropagation()}
        onSubmit={e => {
          e.preventDefault();
          if (!canSave) return;
          setBusy(true);
          setError(null);
          api.saveAdaptiveRouting({
            enabled,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }).then(value => {
            setSettings(value);
            setEnabled(value.enabled);
            setApiKey("");
          }).catch(err => setError(String(err.message || err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Adaptive routing · Jev</h2>
        <p className="help-p">
          Optional TypeSafe Jev routing for new Human requests sent directly to a brain.
          When disabled, Hivemind behaves exactly as before.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={!settings || busy}
          />
          Use Jev to choose single-session vs orchestrated execution
        </label>
        <label>
          TypeSafe API key
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={settings?.apiKeyHint ? `saved ${settings.apiKeyHint}` : "required when enabled"}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="help-p">
          Model: <code>{settings?.model ?? "jev-latest"}</code>. The key is stored only in Hivemind's private local config
          and is never returned to the browser after save.
        </p>
        <p className="help-p">
          When enabled, Hivemind sends TypeSafe only the new request text plus the current project name/slug for routing.
          Repository files, file contents, message history and Hivemind credentials are not sent.
        </p>
        <p className="help-p">
          <strong>single</strong>: the receiving brain executes the request itself without delegating.{" "}
          <strong>orchestrated</strong>: the brain coordinates/delegates normally. Low confidence or Jev failure falls back to orchestrated.
        </p>
        <p className="help-p">
          Brain DMs also offer a one-request <strong>Auto · Jev / Single / Orchestrated</strong> selector.
          Manual Single/Orchestrated choices bypass Jev. Telegram replies in a mapped brain DM use Auto routing when Jev is enabled.
        </p>
        <p className="help-p">
          Only new top-level Human messages in a brain DM are routed. Thread replies and ordinary channel traffic are not reclassified.
        </p>
        {error && <p className="err">{error}</p>}
        {enabled && settings && !settings.apiKeySet && !apiKey.trim() && (
          <p className="help-p">Enter an API key before enabling Jev.</p>
        )}
        <div className="row">
          <button type="button" onClick={onClose}>Close</button>
          <button type="submit" className="primary" disabled={!canSave}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
