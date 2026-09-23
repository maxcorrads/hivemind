import type { Project } from "../src/shared/types.ts";
import { api, type TelegramSettings } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { TelegramSheetState } from "./use-sheets.ts";

export function TelegramSheet({ form, telegram, projects, onSaved, setErr }: {
  form: TelegramSheetState;
  telegram: TelegramSettings;
  projects: Project[];
  /** Receives the saved settings so the snapshot's Telegram health follows them. */
  onSaved: (settings: TelegramSettings) => void;
  setErr: (error: string) => void;
}) {
  const { setTelegramOpen, setTelegram, tgToken, setTgToken, tgUsers, setTgUsers, tgGroups, setTgGroups } = form;
  return (
    <Modal onClose={() => setTelegramOpen(false)}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const known = new Set(projects.map((p) => p.slug));
          const mapped: Record<string, { groupChatId: string }> = {};
          for (const [slug, raw] of Object.entries(tgGroups)) {
            if (!known.has(slug) || !raw.trim()) continue;
            mapped[slug] = { groupChatId: raw.trim() };
          }
          api
            .saveTelegram({
              botToken: tgToken.trim() || undefined,
              allowUserIds: tgUsers.split(/[,\s]+/).filter(Boolean),
              projects: mapped,
            })
            .then((t) => {
              setTelegram(t);
              setTgToken("");
              onSaved(t);
            })
            .catch((ex) => setErr(String(ex.message || ex)));
        }}
      >
        <h2>Telegram</h2>
        <div className="sheet-body">
        <p className="config-status">{telegram.configured ? "Configured" : "Not configured"} · {telegram.running ? "Connected" : "Bridge is off"}</p>
        <h3>Connection</h3>
        <p className="help-p">Connect a bot with admin and Manage Topics permissions.</p>
        <label>
          Bot token
          <input
            type="password"
            value={tgToken}
            onChange={(e) => setTgToken(e.target.value)}
            placeholder={telegram.tokenHint ? `saved ${telegram.tokenHint}` : "from BotFather"}
            autoComplete="off"
          />
        </label>
        <label>
          Allowed user ids
          <input
            value={tgUsers}
            onChange={(e) => setTgUsers(e.target.value)}
            placeholder="123456789"
          />
        </label>
        <details className="settings-disclosure"><summary>Project groups ({projects.filter(p => telegram.projects[p.slug] != null).length}/{projects.length} configured)</summary>
        <p className="help-p">Assign one forum group to each project you want to connect.</p>
        {projects.map((p) => (
          <label key={p.id}>
            {p.name} group chat id
            <input
              value={tgGroups[p.slug] ?? ""}
              onChange={(e) => setTgGroups((cur) => ({ ...cur, [p.slug]: e.target.value }))}
              placeholder="-100…"
            />
          </label>
        ))}
        </details>
        <p className="help-p">Unmapped groups are ignored. Saved next to the hive db, never in git.</p>
        </div>
        <div className="row">
          <button type="button" onClick={() => setTelegramOpen(false)}>
            Close
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
