/**
 * README screenshots only. This page-local WebKit bridge never starts a terminal,
 * launches a process, opens a socket, or calls the Hivemind API.
 */
export const TERMINAL_DEMO_NAMES = Object.freeze([
  'hm-paperplane-atlas',
  'hm-paperplane-forge',
  'hm-paperplane-prism',
  'hm-paperplane-scout',
]);

const DEMOS = [
  {
    name: TERMINAL_DEMO_NAMES[0], agent: 'Atlas', role: 'Coordination', ageMinutes: 47,
    lines: [
      'Reviewing the release workstream',
      '  3 tasks tracked  ·  1 complete  ·  2 active',
      '  Forge completed stable reading-list ordering',
      '  Prism is reviewing keyboard and screen-reader paths',
      '  Scout is verifying keyboard access and sync recovery',
      '',
      'Next: reconcile worker reports and publish the handoff.',
    ],
  },
  {
    name: TERMINAL_DEMO_NAMES[1], agent: 'Forge', role: 'Implementation', ageMinutes: 32,
    lines: [
      'Task: build saved reading lists and stable ordering',
      '  Updated list creation, ordering, and persistence',
      '  Added keyboard reordering and focus restoration',
      '',
      'Focused checks (synthetic demo)',
      '  ✓ list ordering          8 / 8',
      '  ✓ keyboard controls      6 / 6',
      '  ✓ narrow layout          4 / 4',
      '',
      'Result accepted by Atlas. Waiting for the next task.',
    ],
  },
  {
    name: TERMINAL_DEMO_NAMES[2], agent: 'Prism', role: 'Review', ageMinutes: 24,
    lines: [
      'Task: review the reading-list experience',
      '  Checked focus order, labels, and keyboard navigation',
      '  Reviewed stable ordering after an interrupted sync',
      '',
      'Review notes (synthetic demo)',
      '  ✓ focus stays on the moved book',
      '  ✓ controls retain accessible names',
      '  ✓ retry keeps the same operation ID',
      '',
      "Result submitted. Awaiting the assigning brain's review.",
    ],
  },
  {
    name: TERMINAL_DEMO_NAMES[3], agent: 'Scout', role: 'Research', ageMinutes: 16,
    lines: [
      'Task: verify keyboard access and sync recovery',
      '  Checked empty lists and keyboard interactions',
      '  Grouped sync recovery cases by connection state',
      '',
      'Research notes (synthetic demo)',
      '  6 modules surveyed  ·  3 cases to clarify',
      '  No provider or external service contacted',
      '',
      'Next: hand off the verification results.',
    ],
  },
];

/**
 * Install before page.goto(); the mock exists only in each new page navigation. `platform: 'ios'` speaks as the
 * iPhone/iPad app does (HivemindKit RemoteClientBridge): it answers `ready` with its platform and names it in every
 * terminal-status. The default is Hivemind.app on the Mac, whose page reads as "macos".
 */
export async function installTerminalDemo(page, { agents = [], project = 'paperplane', now = Date.now(), platform = 'macos' } = {}) {
  if (!['macos', 'ios'].includes(platform)) throw new Error(`Unknown demo platform ${platform}`);
  const projectSlug = typeof project === 'string' ? project : project.slug;
  if (projectSlug !== 'paperplane') throw new Error('The README terminal demo expects project paperplane');
  const agentList = Array.isArray(agents) ? agents : Object.values(agents);
  const names = new Set(agentList.map(agent => String(agent.name ?? '').toLowerCase()));
  for (const demo of DEMOS) {
    if (!names.has(demo.agent.toLowerCase())) throw new Error(`Missing demo agent ${demo.agent}`);
  }
  const sessions = DEMOS.map(demo => ({
    name: demo.name, project: projectSlug, agent: demo.agent, alive: true, attached: 0,
    createdAt: now - demo.ageMinutes * 60_000,
  }));
  const demos = Object.fromEntries(DEMOS.map(demo => [demo.name, demo]));

  await page.addInitScript(({ sessions, demos, platform }) => {
    // The session redraws at the width the page attaches with, as a CLI in tmux does: a phone gets wrapped lines.
    const wrap = (line, cols) => {
      if (line.length <= cols) return [line];
      const lead = line.match(/^ */)[0];
      const rows = [];
      let row = lead;
      for (const word of line.slice(lead.length).split(/(?<=\s)(?=\S)/)) {
        if (row.trim() && (row + word).trimEnd().length > cols) { rows.push(row.trimEnd()); row = lead + '  '; }
        row += word;
      }
      return [...rows, row.trimEnd()];
    };
    const style = (code, line, cols) => wrap(line, cols).map(row => `\x1b[${code}m${row}\x1b[0m`).join('\r\n');
    const transcript = (demo, cols) => {
      const header = `Demo terminal  ·  ${demo.agent} — ${demo.role}`;
      const ready = '● Session ready  Waiting for the next Hivemind update';
      return {
        first: (header.length <= cols ? `\x1b[1;36mDemo terminal\x1b[0m  ·  \x1b[1m${demo.agent}\x1b[0m — ${demo.role}`
          : `\x1b[1;36mDemo terminal\x1b[0m\r\n\x1b[1m${demo.agent}\x1b[0m — ${demo.role}`) + '\r\n' +
          style(2, 'Synthetic README scene · no command was executed', cols) + '\r\n\r\n',
        second: demo.lines.map(line => line ? style(37, line, cols) : '').join('\r\n') + '\r\n\r\n' +
          (ready.length <= cols ? '\x1b[1;32m● Session ready\x1b[0m  \x1b[2mWaiting for the next Hivemind update\x1b[0m'
            : '\x1b[1;32m● Session ready\x1b[0m\r\n' + style(2, 'Waiting for the next Hivemind update', cols)) + '\r\n',
      };
    };
    const streams = new Map();
    let nextStream = 0;
    window.__readmeUnexpectedNative = [];
    window.__readmeTerminalDemo = { sessions, attached: [], outputDelivered: [] };
    const emit = detail => window.dispatchEvent(new CustomEvent('hivemind:terminal', { detail }));
    const encoded = value => {
      const bytes = new TextEncoder().encode(value);
      return btoa(String.fromCharCode(...bytes));
    };
    const unexpected = message => window.__readmeUnexpectedNative.push(message);
    const output = (stream, text) => {
      if (!streams.has(stream)) return;
      emit({ type: 'terminal-output', stream, data: encoded(text) });
      window.__readmeTerminalDemo.outputDelivered.push(stream);
    };
    const handler = {
      postMessage(message) {
        if (!message || typeof message !== 'object') { unexpected(message); return; }
        switch (message.type) {
          case 'ready':
            if (platform === 'ios') queueMicrotask(() => window.dispatchEvent(new CustomEvent('hivemind:native',
              { detail: { command: 'ready', platform } })));
            return;
          case 'badge':
          case 'notify':
            return;
          case 'sessions-subscribe':
            queueMicrotask(() => {
              emit({ type: 'terminal-status', tmux: 'available', broker: 'connected', platform });
              emit({ type: 'sessions', items: sessions });
            });
            return;
          case 'sessions-unsubscribe':
            return;
          case 'terminal-attach': {
            const demo = demos[message.session];
            if (!demo || typeof message.id !== 'string') {
              unexpected(message);
              queueMicrotask(() => emit({ type: 'terminal-error', id: message.id ?? null,
                code: 'no-such-session', message: 'No demo session', stream: null }));
              return;
            }
            const stream = ++nextStream;
            streams.set(stream, { session: message.session, timers: [] });
            window.__readmeTerminalDemo.attached.push(message.session);
            // The page registers its pending attach after postMessage returns.
            queueMicrotask(() => emit({ type: 'terminal-attached', id: message.id, stream, session: message.session }));
            const entry = streams.get(stream);
            // One column spare: the last one can sit under the terminal's edge.
            const text = transcript(demo, Number.isSafeInteger(message.cols) ? message.cols - 1 : 80);
            entry.timers.push(setTimeout(() => output(stream, text.first), 30));
            entry.timers.push(setTimeout(() => output(stream, text.second), 100));
            return;
          }
          case 'terminal-resize':
          case 'terminal-ack':
            if (!streams.has(message.stream)) unexpected(message);
            return;
          case 'terminal-detach': {
            const entry = streams.get(message.stream);
            if (!entry) { unexpected(message); return; }
            for (const timer of entry.timers) clearTimeout(timer);
            streams.delete(message.stream);
            return;
          }
          default:
            unexpected(message);
        }
      },
    };
    Object.defineProperty(window, 'webkit', { configurable: true,
      value: { messageHandlers: { hivemind: handler } } });
  }, { sessions, demos, platform });
}
