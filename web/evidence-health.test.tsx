import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { mergeRoutingView } from './adaptive-routing-view.ts';
import { AdaptiveRoutingPanel } from './AdaptiveRoutingPanel.tsx';
import { captureLabel, collectorHealthLabel } from './EvidenceHealth.tsx';
import type { AdaptiveExecutionState, AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';
import { HEALTHY_EVIDENCE_COLLECTOR, type EvidenceCollectorHealth } from '../src/shared/evidence-health.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, location: window.location,
  HTMLElement: window.HTMLElement, HTMLSelectElement: window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

const degraded: EvidenceCollectorHealth = { ...HEALTHY_EVIDENCE_COLLECTOR, status: 'degraded', failures: { begin: 1, finish: 0, marker: 2 },
  lastFailureAt: 5, pendingGaps: 1 };
function state(evidence?: AdaptiveExecutionState['evidence']): AdaptiveExecutionState {
  return { executionId: 'run', channelId: 'a', projectId: 'project', brainId: 'brain', rootMessageId: 'root', recommendation: null,
    updatedAt: 1, revision: 1, monitoring: 'active', ...(evidence ? { evidence } : {}) };
}
async function render(t: TestContext, view: AdaptiveRoutingView) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(createElement(AdaptiveRoutingPanel, { channelId: 'a', view, onClose: () => {} })));
  return host;
}

test('collector and capture labels separate measurement health from Jev availability', () => {
  assert.equal(collectorHealthLabel(HEALTHY_EVIDENCE_COLLECTOR), null);
  assert.match(collectorHealthLabel(degraded)!, /failing to save \(1 execution\).*Routing is unaffected.*lost if the server stops/);
  assert.match(collectorHealthLabel({ ...degraded, overflow: true })!, /too many to track/);
  assert.match(collectorHealthLabel({ ...degraded, status: 'recovered', pendingGaps: 0, persistedGaps: 2 })!, /recovered.*2 gap markers saved/);
  assert.equal(captureLabel(undefined), null);
  assert.match(captureLabel({ capture: 'complete', reasons: [] })!, /complete/);
  assert.match(captureLabel({ capture: 'incomplete', reasons: ['collection_gap', 'history_truncated'] })!,
    /incomplete · some attempts were not recorded · older attempt detail was pruned.*not a full-execution total/);
  assert.match(captureLabel({ capture: 'unknown', reasons: ['legacy_record'] })!, /unknown · recorded before health tracking/);
});

test('the Human routing panel shows collector warnings and per-execution capture state', async t => {
  const host = await render(t, { state: state({ capture: 'incomplete', reasons: ['collection_gap'] }), events: [], collector: degraded });
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /failing to save/);
  assert.match(host.textContent!, /Measurement incomplete · some attempts were not recorded/);
  const healthy = await render(t, { state: state({ capture: 'complete', reasons: [] }), events: [], collector: HEALTHY_EVIDENCE_COLLECTOR });
  assert.doesNotMatch(healthy.textContent!, /failing to save|recovered/);
  assert.match(healthy.textContent!, /Measurement complete/);
});

test('routing merges keep the latest collector health across realtime updates without one', () => {
  const merged = mergeRoutingView({ state: state(), events: [], collector: degraded }, { state: state(), events: [] }, 'a');
  assert.equal(merged.collector?.status, 'degraded');
  const recovered = mergeRoutingView(merged, { state: null, events: [], collector: { ...degraded, status: 'recovered' } }, 'a');
  assert.equal(recovered.collector?.status, 'recovered');
});
