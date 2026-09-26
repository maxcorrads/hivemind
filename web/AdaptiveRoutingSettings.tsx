import { ChevronRight, Route } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { useEffect, useState } from "react";
import { api, type AdaptiveRoutingSettings } from "./api.ts";
import { JevConnectionTest } from "./JevConnectionTest.tsx";
import { JEV_MODEL_ALIAS, validJevModel } from "../src/shared/jev-model.ts";

export function AdaptiveRoutingSettings({ onClose, onSaved }: { onClose: () => void; onSaved?: (settings: AdaptiveRoutingSettings) => void }) {
  const [settings, setSettings] = useState<AdaptiveRoutingSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  /** Empty means the default alias; otherwise the exact identifier to pin. */
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.adaptiveRouting()
      .then(value => {
        if (!active) return;
        setSettings(value);
        setEnabled(value.enabled);
        setModel(value.modelPinned ? value.model : "");
      })
      .catch(err => { if (active) setError(String(err.message || err)); });
    return () => { active = false; };
  }, []);

  const pinned = model.trim();
  const modelValid = !pinned || validJevModel(pinned);
  const canSave = Boolean(settings) && !busy && modelValid && (!enabled || settings!.apiKeySet || apiKey.trim().length > 0);
  const dirty = !settings || Boolean(apiKey.trim()) || enabled !== settings.enabled ||
    pinned !== (settings.modelPinned ? settings.model : "");

  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <form
        className="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="Adaptive routing settings"
        onClick={e => e.stopPropagation()}
        onSubmit={e => {
          e.preventDefault();
          if (!canSave) return;
          setBusy(true);
          setError(null);
          api.saveAdaptiveRouting({
            enabled,
            model: pinned || null,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }).then(value => {
            setSettings(value);
            setEnabled(value.enabled);
            setModel(value.modelPinned ? value.model : "");
            setApiKey("");
            onSaved?.(value);
          }).catch(err => setError(String(err.message || err)))
            .finally(() => setBusy(false));
        }}
      >
        <header className="sheet-head">
          <span className="sheet-icon" aria-hidden="true"><Route size={17} /></span>
          <div><h2>Adaptive routing · Jev</h2><p>Advisory only: the brain decides.</p></div>
        </header>
        <div className="sheet-body">
        <p className="help-p">Jev advises brains on how many agents a request needs. Its advice is never enforced: the brain decides, and your instructions always take precedence.</p>
        <p className="config-status" role="status">{!settings ? "Loading settings…" : settings.enabled ? "Enabled" : "Disabled"} · {settings?.apiKeySet ? "API key configured" : "No API key saved"}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={!settings || busy}
          />
          Enable Jev advice
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
        <p className="help-p">The API key stays in your private local configuration.</p>
        <JevConnectionTest savedSettings={settings} disabled={busy || dirty} />
        <details className="settings-disclosure sheet-disclosure"><summary><ChevronRight size={14} aria-hidden="true" />Advanced options</summary>
        <p className="help-p">If Jev is uncertain or unavailable, the brain is told so and simply decides without advice.</p>
        <label>
          Jev model identifier
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={`${settings?.defaultModel ?? JEV_MODEL_ALIAS} (default alias)`}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!modelValid}
            disabled={!settings || busy}
          />
        </label>
        <p className="help-p">Requested model: <code>{settings?.model ?? JEV_MODEL_ALIAS}</code> · {settings?.modelPinned ? "pinned identifier" : "default alias"}. Leave empty to use the alias <code>{settings?.defaultModel ?? JEV_MODEL_ALIAS}</code>, which TypeSafe may resolve to a different model over time. Enter an exact identifier from your provider to pin it for reproducible routing evaluation. Hivemind does not list models or prices and does not verify that an identifier exists or never changes: if TypeSafe rejects it, Jev calls fail visibly and brains get no advice. The Routing log records the requested and the resolved model separately. The TypeSafe endpoint never changes.</p>
        {!modelValid && <p className="err">Use only letters, digits, dot, underscore or hyphen (at most 64 characters), not a URL.</p>}
        </details>
        <details className="settings-disclosure sheet-disclosure"><summary><ChevronRight size={14} aria-hidden="true" />What data is sent to Jev?</summary>
        <p className="help-p">Every message you address to a brain — in any channel, thread or via Telegram — sends that request and the project name/slug to TypeSafe before delivery. Each brain action (message, file, task, room or thread change, and each wait that delivers mail) sends the request again with worker capacity, the brain's task/dependency/blocker counts, a short summary of the action, recent actions and the previous advice. Worker activity is never sent.</p>
        <p className="help-p">Repository contents, full message history and Hivemind credentials are not sent.</p>
        </details>
        {error && <p className="err">{error}</p>}
        {enabled && settings && !settings.apiKeySet && !apiKey.trim() && (
          <p className="help-p">Enter an API key before enabling Jev.</p>
        )}
        </div>
        <div className="row sheet-footer">
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
          <button type="submit" className="primary" disabled={!canSave}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
