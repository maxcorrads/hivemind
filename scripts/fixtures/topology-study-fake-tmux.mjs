// Fake tmux (and fake "open Terminal" command) for the --watch host tests. Usage: node fake-tmux.mjs <log> [mode] <tmux args...>
// Every invocation is appended to <log> as a JSON array. mode "fail" makes every command fail; otherwise there is no
// session at first, no attached client, and created panes report ids like tmux does.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [log, mode, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify([mode, ...args]) + '\n');
if (mode === 'fail') { process.stderr.write('fake tmux failure\n'); process.exit(1); }
const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
if (args[0] === 'has-session') process.exit(calls.some(c => c[1] === 'new-session') ? 0 : 1);
if (['new-window', 'split-window'].includes(args[0])) console.log(`%${calls.length}`);
