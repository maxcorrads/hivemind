import type { Agent, Channel } from "../src/shared/types.ts";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { ChannelSheets } from "./use-sheets.ts";

export function CreateChannelSheet({ form, agents, defaultProject, onCreated, setErr }: {
  form: ChannelSheets;
  agents: Agent[];
  /** Project used when the sheet was not opened from a project section. */
  defaultProject: string | undefined;
  onCreated: (channel: Channel) => Promise<void>;
  setErr: (error: string) => void;
}) {
  const { newName, setNewName, newTopic, setNewTopic, newType, setNewType, newMembers, setNewMembers, createIn,
    setCreating, setCreateIn } = form;

  const onCreate = async () => {
    if (!newName.trim()) return;
    const project = createIn ?? defaultProject;
    const { channel } = await api.createChannel(
      newName.trim(),
      newType,
      newTopic.trim() || undefined,
      newType === "private" ? newMembers : undefined,
      project,
    );
    setCreating(false);
    setCreateIn(null);
    setNewName("");
    setNewTopic("");
    setNewMembers([]);
    await onCreated(channel);
  };

  return (
    <Modal onClose={() => setCreating(false)}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onCreate().catch((ex) => setErr(String(ex.message || ex)));
        }}
      >
        <h2>New channel</h2>
        <label>
          Name
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="frontend" autoFocus />
        </label>
        <label>
          Topic
          <input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="optional" />
        </label>
        <label>
          Visibility
          <select value={newType} onChange={(e) => setNewType(e.target.value as "public" | "private")}>
            <option value="public">public — everyone</option>
            <option value="private">private — invited</option>
          </select>
        </label>
        {newType === "private" && (
          <fieldset className="checks">
            <legend>Members</legend>
            {agents
              .filter((a) => a.role !== "human" && (!createIn || a.project === createIn))
              .map((a) => (
              <label key={a.id} className="check">
                <input
                  type="checkbox"
                  checked={newMembers.includes(a.name)}
                  onChange={(e) =>
                    setNewMembers((cur) =>
                      e.target.checked ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                    )
                  }
                />
                {a.name}
              </label>
            ))}
          </fieldset>
        )}
        <div className="row">
          <button type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function InviteSheet({ form, channel, agents, onInvited, setErr }: {
  form: ChannelSheets;
  channel: Channel;
  agents: Agent[];
  onInvited: () => Promise<void>;
  setErr: (error: string) => void;
}) {
  const { inviteNames, setInviteNames, setInviteOpen } = form;
  return (
    <Modal onClose={() => setInviteOpen(false)}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          api
            .invite(channel.id, inviteNames)
            .then(async () => {
              setInviteOpen(false);
              setInviteNames([]);
              await onInvited();
            })
            .catch((ex) => setErr(String(ex.message || ex)));
        }}
      >
        <h2>Invite to #{channel.name}</h2>
        <fieldset className="checks">
          <legend>Agents and bots</legend>
          {agents
            .filter(
              (a) =>
                a.role !== "human" &&
                a.project === channel.project &&
                !channel.memberIds.includes(a.id),
            )
            .map((a) => (
              <label key={a.id} className="check">
                <input
                  type="checkbox"
                  checked={inviteNames.includes(a.name)}
                  onChange={(e) =>
                    setInviteNames((cur) =>
                      e.target.checked ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                    )
                  }
                />
                {a.name} · {a.role}
              </label>
            ))}
        </fieldset>
        <div className="row">
          <button type="button" onClick={() => setInviteOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Invite
          </button>
        </div>
      </form>
    </Modal>
  );
}
