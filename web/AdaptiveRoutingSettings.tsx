import { useEffect, useState } from "react";
import { api, type AdaptiveRoutingSettings } from "./api.ts";
import type { AdaptiveTopology } from "../src/shared/adaptive-topology.ts";

export function AdaptiveRoutingSettings({ onClose }: { onClose: () => void }) {
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
            fallback,
            topologyFallback,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }).then(value => {
            setSettings(value);
            setEnabled(value.enabled);
            setFallback(value.fallback);
            setTopologyFallback(value.topologyFallback);
            setApiKey("");
          }).catch(err => setError(String(err.message || err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Adaptive routing · Jev</h2>
        <p className="help-p">
          TypeSafe Jev selects and continuously revalidates Single, Brain + 1, Multi-DM or Room for Human requests sent to a brain.
          When disabled, Auto behaves exactly as legacy Hivemind.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={!settings || busy}
          />
          Use Jev for continuous execution-topology routing
        </label>
        <label>
          Fallback when Jev is uncertain or unavailable
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
          Initial routing sends the Human request plus project name/slug. Continuous checks send a bounded structured snapshot:
          current topology, live worker capacity, task/dependency/blocker counts, recent coordination events, locks and the previous decision.
          Repository/file contents, full message history and Hivemind credentials are not sent.
        </p>
        <p className="help-p">
          During continuous execution, Jev failure preserves the current topology and raises a Human-only warning.
          Initial provider failure uses the configured Single/Orchestrated fallback; orchestrated fallback starts with the topology fallback above.
        </p>
        <p className="help-p">
          Brain DMs expose <strong>Auto · Jev / Single / Brain + 1 / Multi-DM / Room / Orchestrated Auto</strong>.
          Manual choices can be one-shot or locked to the task/conversation. Jev still evaluates locked executions but cannot override the Human lock.
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
