import { Modal } from "./Modal.tsx";
import { useEffect, useState } from "react";
import { api, type AdaptiveRoutingSettings } from "./api.ts";
import type { AdaptiveTopology } from "../src/shared/adaptive-topology.ts";

export function AdaptiveRoutingSettings({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [settings, setSettings] = useState<AdaptiveRoutingSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [fallback, setFallback] = useState<"single" | "orchestrated">("orchestrated");
  const [topologyFallback, setTopologyFallback] =
    useState<Exclude<AdaptiveTopology, "single">>("brain_one_worker");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.adaptiveRouting()
      .then(value => {
        if (!active) return;
        setSettings(value);
        setEnabled(value.enabled);
        setFallback(value.fallback);
        setTopologyFallback(value.topologyFallback);
      })
      .catch(err => { if (active) setError(String(err.message || err)); });
    return () => { active = false; };
  }, []);

  const canSave = Boolean(settings) && !busy && (!enabled || settings!.apiKeySet || apiKey.trim().length > 0);

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
            fallback,
            topologyFallback,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }).then(value => {
            setSettings(value);
            setEnabled(value.enabled);
            setFallback(value.fallback);
            setTopologyFallback(value.topologyFallback);
            setApiKey("");
            onSaved?.();
          }).catch(err => setError(String(err.message || err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Adaptive routing · Jev</h2>
        <div className="sheet-body">
        <p className="help-p">Let Jev choose how many agents a request needs and adjust the team as work progresses.</p>
        <p className="config-status" role="status">{!settings ? "Loading settings…" : settings.enabled ? "Enabled" : "Disabled"} · {settings?.apiKeySet ? "API key configured" : "No API key saved"}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={!settings || busy}
          />
          Enable adaptive routing
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
        <details className="settings-disclosure"><summary>Fallback and advanced options</summary>
        <label>
          Initial fallback when Jev is uncertain or unavailable
          <select
            value={fallback}
            onChange={e => setFallback(e.target.value as "single" | "orchestrated")}
            disabled={!settings || busy}
          >
            <option value="orchestrated">Orchestrated · safer default</option>
            <option value="single">Single · lower cost, higher under-routing risk</option>
          </select>
        </label>
        <label>
          Orchestrated topology fallback
          <select
            value={topologyFallback}
            onChange={e => setTopologyFallback(e.target.value as Exclude<AdaptiveTopology, "single">)}
            disabled={!settings || busy}
          >
            <option value="brain_one_worker">Brain + 1 · lowest coordination overhead</option>
            <option value="brain_multi_dm">Multi-DM</option>
            <option value="brain_multi_room">Room</option>
          </select>
        </label>
        <p className="help-p">If Jev is unavailable, new requests use these fallbacks. Existing work keeps its current team and shows a warning.</p>
        <p className="help-p">Model: <code>{settings?.model ?? "jev-latest"}</code>. Manual routing can apply once or stay locked to a task or conversation.</p>
        </details>
        <details className="settings-disclosure"><summary>What data is sent to Jev?</summary>
        <p className="help-p">New brain DMs send your request and project name/slug to TypeSafe. Ongoing checks send the current topology, worker capacity, task/dependency/blocker counts, recent coordination events, locks and the previous decision.</p>
        <p className="help-p">Repository contents, full message history and Hivemind credentials are not sent. Thread replies and ordinary channel messages are not routed.</p>
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
