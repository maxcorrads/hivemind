import { Modal } from "./Modal.tsx";
import { useEffect, useState } from "react";
import { api, type AdaptiveRoutingSettings } from "./api.ts";
import type { AdaptiveTopology } from "../src/shared/adaptive-topology.ts";
import { JevConnectionTest } from "./JevConnectionTest.tsx";
import { JEV_MODEL_ALIAS, validJevModel } from "../src/shared/jev-model.ts";

export function AdaptiveRoutingSettings({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [settings, setSettings] = useState<AdaptiveRoutingSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [fallback, setFallback] = useState<"single" | "orchestrated">("orchestrated");
  const [topologyFallback, setTopologyFallback] =
    useState<Exclude<AdaptiveTopology, "single">>("brain_one_worker");
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
        setFallback(value.fallback);
        setTopologyFallback(value.topologyFallback);
        setModel(value.modelPinned ? value.model : "");
      })
      .catch(err => { if (active) setError(String(err.message || err)); });
    return () => { active = false; };
  }, []);

  const pinned = model.trim();
  const modelValid = !pinned || validJevModel(pinned);
  const canSave = Boolean(settings) && !busy && modelValid && (!enabled || settings!.apiKeySet || apiKey.trim().length > 0);
  const dirty = !settings || Boolean(apiKey.trim()) || enabled !== settings.enabled ||
    fallback !== settings.fallback || topologyFallback !== settings.topologyFallback ||
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
            fallback,
            topologyFallback,
            model: pinned || null,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }).then(value => {
            setSettings(value);
            setEnabled(value.enabled);
            setFallback(value.fallback);
            setTopologyFallback(value.topologyFallback);
            setModel(value.modelPinned ? value.model : "");
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
        <JevConnectionTest savedSettings={settings} disabled={busy || dirty} />
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
        <p className="help-p">Requested model: <code>{settings?.model ?? JEV_MODEL_ALIAS}</code> · {settings?.modelPinned ? "pinned identifier" : "default alias"}. Leave empty to use the alias <code>{settings?.defaultModel ?? JEV_MODEL_ALIAS}</code>, which TypeSafe may resolve to a different model over time. Enter an exact identifier from your provider to pin it for reproducible routing evaluation. Hivemind does not list models or prices and does not verify that an identifier exists or never changes: if TypeSafe rejects it, Jev calls fail visibly and current teams are kept. The Routing log records the requested and the resolved model separately. The TypeSafe endpoint never changes.</p>
        {!modelValid && <p className="err">Use only letters, digits, dot, underscore or hyphen (at most 64 characters), not a URL.</p>}
        <p className="help-p">Manual routing can apply once or stay locked to a task or conversation.</p>
        </details>
        <details className="settings-disclosure"><summary>What data is sent to Jev?</summary>
        <p className="help-p">Every message you address to a brain — in any channel, thread or via Telegram — sends that request and the project name/slug to TypeSafe before delivery. Messages without a brain and worker activity are never sent. Ongoing checks send the current topology, worker capacity, task/dependency/blocker counts, recent coordination events, locks and the previous decision.</p>
        <p className="help-p">Repository contents, full message history and Hivemind credentials are not sent. Thread replies and channel coordination events can trigger ongoing checks, but do not start a new routed Human request.</p>
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
