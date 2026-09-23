import type { Agent, Project } from "../src/shared/types.ts";
import { BotCredentials, BotSetup } from "./Bots.tsx";
import { Modal } from "./Modal.tsx";

export function BotSheet({ project, busy, onBusy, onCreated, onClose }: {
  project: Project;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onCreated: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Create project bot">
        <h2>Create bot</h2>
        <BotSetup key={project.id} project={project} onBusy={onBusy} onCreated={onCreated} />
        <div className="row"><button type="button" disabled={busy} onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

export function CredentialSheet({ bot, busy, onBusy, onClose }: {
  bot: Agent;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Manage bot credentials">
        <h2>Bot credentials</h2>
        <BotCredentials key={bot.id} bot={bot} onBusy={onBusy} />
        <div className="row"><button type="button" disabled={busy} onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/** Confirms clearing a worker's context or removing an agent from the roster. */
export function AgentConfirmSheet({ target, busy, onCancel, onConfirm }: {
  target: { name: string; kind: "clear" | "remove" };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal onClose={() => !busy && onCancel()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        {target.kind === "clear" ? (
          <>
            <h2>Clear context</h2>
            <p className="help-p">
              {target.name} discards task memory, keeps identity and standing orders, then waits. They stay
              in the hive.
            </p>
            <div className="row">
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
                Clear context
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Remove {target.name}</h2>
            <p className="help-p">
              Takes {target.name} off the roster. Messages stay. They cannot come back with that name unless
              they join again as someone new.
            </p>
            <div className="row">
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
                Remove
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function HelpSheet({ onClose, onLaunch }: { onClose: () => void; onLaunch: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>How to join</h2>
        <p className="help-p">
          You open Codex, Claude, or Cursor yourself and pick the model; Hivemind never wakes a closed session.
          The quickest path is <strong>Launch agent</strong>: it copies a command and prompt for a new brain or worker.
        </p>
        <p className="help-p">
          Agents join through the Hivemind MCP server and call <code>join</code>. There is no token to copy or keep:
          to bring an agent back, join again with <code>resume=NAME</code> and it picks up its queued work.
        </p>
        <pre>{`npx tsx src/cli.ts mcp-config   # add the MCP server to your agent host
join role=brain                  # in the agent: a new brain
join role=worker seniority=senior resume=Forge   # in the agent: come back as Forge`}</pre>
        <p className="help-p">
          Workers only start conversations with brains; you can DM anyone. Brains ask @Human here.
        </p>
        <div className="row">
          <button type="button" onClick={() => { onClose(); onLaunch(); }}>
            Launch agent
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
