import { ArrowDown, ArrowUp, Copy, FolderCog, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ACCOUNT_DRIVERS, ACCOUNT_LIMITS, ACCOUNT_POLICIES, accountLoginCommand, accountPathProblem, type AccountDriver,
  toLaunchAccount, type AccountPolicy, type AccountUsage as Usage, type AgentAccount } from "../src/shared/accounts.ts";
import { api, type AccountsView } from "./api.ts";
import { AccountUsage, useNow } from "./AccountUsage.tsx";
import { Modal } from "./Modal.tsx";
import { terminalHub, type AccountPreparation } from "./use-terminal.ts";

const DRIVER_NAMES: Record<AccountDriver, string> = { codex: "Codex", claude: "Claude" };
const POLICY_NAMES: Record<AccountPolicy, string> = { sequential: "Sequential", balanced: "Balanced" };
const POLICY_LINES: Record<AccountPolicy, string> = {
  sequential: "Use the first account until a quota window is used up, then the next.",
  balanced: "Spread launches; prefer the account with the most quota left in the window that resets first.",
};

/** An account's editable fields. A path is stored exactly as typed; "" is the driver's default tree or no shadow. */
type AccountFields = { label: string; homePath: string; shadowPath: string };

/** A row's last Prepare, for the paths it ran with: null while the app works on it. */
type Prepared = { homePath: string; shadowPath: string; result: AccountPreparation | null };

const errorText = (failure: unknown) => String((failure as Error)?.message || failure);

/**
 * Settings → Accounts: the named Codex and Claude logins a launch can use. HiveMind keeps paths, order and policy
 * only; each login stays a terminal command Human runs once (docs/accounts.md#catalog). `tick` changes on every
 * `accounts` event, which refetches the list.
 */
export function AccountsSheet({ tick = 0, onClose }: { tick?: number; onClose: () => void }) {
  const [view, setView] = useState<AccountsView | null>(null);
  // Each account's latest usage, read with the catalog; a change or an accounts event brings a newer one.
  const [usage, setUsage] = useState<Usage[]>([]);
  const now = useNow();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<AccountDriver | null>(null);
  // The account as the edit found it: its revision stays the one the edit started from, even after a refetch.
  const [editing, setEditing] = useState<AgentAccount | null>(null);
  const [deleting, setDeleting] = useState<AgentAccount | null>(null);
  const [reload, setReload] = useState(0);
  // By account id. Only the apps can prepare: Hivemind Server.app builds the shadow (docs/accounts.md#sheet).
  const [prepared, setPrepared] = useState<Record<string, Prepared>>({});
  const hub = terminalHub();
  useEffect(() => {
    let active = true;
    setError("");
    api.accounts()
      .then(result => { if (active) { setView(result); setUsage(result.usage); } })
      .catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [tick, reload]);

  // One change at a time: the controls are disabled while it runs, and a refused change is shown as text.
  const change = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const refetch = () => setReload(value => value + 1);

  const move = (driver: AccountDriver, accounts: AgentAccount[], index: number, step: -1 | 1) => {
    const ids = accounts.map(account => account.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + step, 0, id!);
    void change(async () => setView(await api.reorderAccounts(driver, ids)));
  };

  // A status is about the paths it ran with: an edit of either path hides it.
  const preparedFor = (account: AgentAccount) => {
    const last = prepared[account.id];
    return last && last.homePath === account.homePath && last.shadowPath === account.shadowPath ? last : null;
  };
  // A shadow is built before Human runs its login command, which shows once Prepare succeeds; the row keeps the status.
  const prepare = (account: AgentAccount) => {
    if (!hub) return;
    const paths = { homePath: account.homePath, shadowPath: account.shadowPath };
    setPrepared(old => ({ ...old, [account.id]: { ...paths, result: null } }));
    hub.prepareAccount(toLaunchAccount(account))
      .catch((failure): AccountPreparation => ({ ok: false, loggedIn: false, error: errorText(failure) }))
      .then(result => setPrepared(old => ({ ...old, [account.id]: { ...paths, result } })));
  };

  const remove = (account: AgentAccount) => {
    setDeleting(null);
    void change(async () => {
      await api.deleteAccount(account.id, account.revision);
      refetch();
    });
  };

  return (
    <Modal onClose={() => { if (!busy && !adding && !editing && !deleting) onClose(); }}>
      <div className="sheet sheet-wide accounts-sheet" role="dialog" aria-modal="true" aria-label="Accounts"
        onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>Accounts</h2>
            <p>Named logins for Codex and Claude. HiveMind keeps paths, order and policy, never a token.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close dialog" title="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          {error && <p className="err" role="alert">{error}</p>}
          {view === null && !error && <p role="status">Loading…</p>}
          {!hub && <p className="help-p">Prepare needs the Mac app</p>}
          {view && ACCOUNT_DRIVERS.map(driver => {
            const accounts = view.accounts.filter(account => account.driver === driver);
            const policy = view.policies[driver];
            return (
              <section key={driver} className="bot-settings-card" aria-label={`${DRIVER_NAMES[driver]} accounts`}>
                <div className="bot-settings-heading">
                  <strong>{DRIVER_NAMES[driver]}</strong>
                  <span>{accounts.length} of {ACCOUNT_LIMITS.perDriver}</span>
                </div>
                <fieldset className="launch-seg">
                  <legend>Policy</legend>
                  <div className="seg">
                    {ACCOUNT_POLICIES.map(value => (
                      <label key={value} className={policy === value ? "on" : ""}>
                        <input type="radio" className="sr-only" name={`${driver}-policy`} value={value} checked={policy === value}
                          disabled={busy} onChange={() => void change(async () => setView(await api.setAccountPolicy(driver, value)))} />
                        {POLICY_NAMES[value]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {ACCOUNT_POLICIES.map(value => (
                  <p key={value} className="help-p"><strong>{POLICY_NAMES[value]}.</strong> {POLICY_LINES[value]}</p>
                ))}
                <ol className="accounts-list">
                  {accounts.map((account, index) => (
                    <li key={account.id}>
                      {editing?.id === account.id ? (
                        <AccountForm driver={driver} submitLabel="Save account" busy={busy}
                          initial={{ label: editing.label, homePath: editing.homePath, shadowPath: editing.shadowPath }}
                          onCancel={() => setEditing(null)}
                          onSubmit={fields => void change(async () => {
                            await api.updateAccount(editing.id, { expectedRevision: editing.revision, ...fields });
                            setEditing(null);
                            refetch();
                          })} />
                      ) : (<>
                        <div className="bot-settings-heading">
                          <strong>{account.label}</strong>
                          <span>Home path <code>{account.homePath || "default"}</code></span>
                          <span>Shadow path <code>{account.shadowPath || "none"}</code></span>
                          <button type="button" className="btn" disabled={busy || index === 0} aria-label={`Move ${account.label} up`}
                            onClick={() => move(driver, accounts, index, -1)}>
                            <ArrowUp size={13} aria-hidden="true" /> Up
                          </button>
                          <button type="button" className="btn" disabled={busy || index === accounts.length - 1}
                            aria-label={`Move ${account.label} down`} onClick={() => move(driver, accounts, index, 1)}>
                            <ArrowDown size={13} aria-hidden="true" /> Down
                          </button>
                          {hub && (
                            <button type="button" className="btn" disabled={busy || preparedFor(account)?.result === null}
                              aria-label={`Prepare ${account.label}`} onClick={() => prepare(account)}>
                              <FolderCog size={13} aria-hidden="true" /> Prepare
                            </button>
                          )}
                          <button type="button" className="btn" disabled={busy} aria-label={`Edit ${account.label}`}
                            onClick={() => { setAdding(null); setEditing(account); }}>
                            <Pencil size={13} aria-hidden="true" /> Edit
                          </button>
                          <button type="button" className="btn btn-danger" disabled={busy} aria-label={`Remove ${account.label}`}
                            onClick={() => setDeleting(account)}>
                            <Trash2 size={13} aria-hidden="true" /> Remove
                          </button>
                        </div>
                        <PreparedStatus account={account} prepared={preparedFor(account)} />
                        <AccountUsage usage={usage.find(item => item.accountId === account.id)} now={now} />
                      </>)}
                    </li>
                  ))}
                </ol>
                {adding === driver ? (
                  <AccountForm driver={driver} submitLabel="Add account" busy={busy} showLogin
                    initial={{ label: "", homePath: "", shadowPath: "" }}
                    onCancel={() => setAdding(null)}
                    onSubmit={fields => void change(async () => {
                      await api.createAccount({ driver, ...fields });
                      setAdding(null);
                      refetch();
                    })} />
                ) : (
                  <button type="button" className="btn" disabled={busy || accounts.length >= ACCOUNT_LIMITS.perDriver}
                    onClick={() => { setEditing(null); setAdding(driver); }}>
                    <Plus size={13} aria-hidden="true" /> Add account
                  </button>
                )}
              </section>
            );
          })}
        </div>
        <div className="row">
          <button type="button" disabled={busy} onClick={onClose}>Close</button>
        </div>
      </div>
      {deleting && (
        <Modal onClose={() => { if (!busy) setDeleting(null); }}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-label={`Remove ${deleting.label}`}
            onClick={event => event.stopPropagation()}>
            <h2>Remove {deleting.label}?</h2>
            <p className="help-p">HiveMind forgets this account. Its folders and login stay where they are.</p>
            <div className="row">
              <button type="button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
              <button type="button" className="danger" disabled={busy} onClick={() => remove(deleting)}>Remove</button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

/**
 * An account's label and paths, with the path rules checked as Human types. Add also shows the login command for
 * the paths typed, with a Copy button: Human runs it once in a terminal.
 */
function AccountForm({ driver, initial, busy, submitLabel, showLogin, onSubmit, onCancel }: {
  driver: AccountDriver;
  initial: AccountFields;
  busy: boolean;
  submitLabel: string;
  showLogin?: boolean;
  onSubmit: (fields: AccountFields) => void;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState(initial);
  const set = (patch: Partial<AccountFields>) => setFields(old => ({ ...old, ...patch }));
  const homeProblem = accountPathProblem(fields.homePath);
  const shadowProblem = accountPathProblem(fields.shadowPath);
  const pathsValid = !homeProblem && !shadowProblem;
  const valid = fields.label.trim() !== "" && pathsValid;
  // The command depends on the paths only, so it shows before a label is typed.
  const login = showLogin && pathsValid ? accountLoginCommand({ driver, homePath: fields.homePath, shadowPath: fields.shadowPath }) : null;

  return (
    <form className="template-editor account-form" aria-label={`${submitLabel} for ${DRIVER_NAMES[driver]}`}
      onSubmit={event => {
        event.preventDefault();
        if (valid && !busy) onSubmit({ label: fields.label.trim(), homePath: fields.homePath, shadowPath: fields.shadowPath });
      }}>
      <label>
        Label
        <input value={fields.label} maxLength={ACCOUNT_LIMITS.label} placeholder={`${DRIVER_NAMES[driver]} work`} autoFocus
          onChange={event => set({ label: event.target.value })} />
      </label>
      <label>
        Home path
        <input className="mono" value={fields.homePath} placeholder={`empty for the default, or ~/.${driver}-work`}
          autoComplete="off" spellCheck={false} aria-invalid={homeProblem ? true : undefined}
          onChange={event => set({ homePath: event.target.value })} />
      </label>
      {homeProblem && <p className="err">Home path: {homeProblem}</p>}
      <label>
        Shadow path
        <input className="mono" value={fields.shadowPath} placeholder="empty for a primary account, or ~/.codex_personal"
          autoComplete="off" spellCheck={false} aria-invalid={shadowProblem ? true : undefined}
          onChange={event => set({ shadowPath: event.target.value })} />
      </label>
      {shadowProblem && <p className="err">Shadow path: {shadowProblem}</p>}
      {login && <LoginCommand command={login} />}
      <div className="row">
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !valid}>{busy ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  );
}

/** A row's Prepare status: "Ready", "Not logged in" or what is wrong; once Prepare worked, the login command to run. */
function PreparedStatus({ account, prepared }: { account: AgentAccount; prepared: Prepared | null }) {
  if (!prepared) return null;
  const { result } = prepared;
  const status = !result ? "Preparing…" : !result.ok ? result.error ?? "Prepare failed" : result.loggedIn ? "Ready" : "Not logged in";
  return (
    <>
      <p className={result?.ok === false ? "err" : "help-p"} role="status">{status}</p>
      {result?.ok && <LoginCommand command={accountLoginCommand(account)} />}
    </>
  );
}

/** An account's login command with a Copy button, and the line that says Human runs it once. */
function LoginCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed; select the command to copy it");
    }
  };
  return (
    <>
      <pre className="launch-pre">{command}</pre>
      <div className="row">
        <button type="button" className="btn" onClick={() => void copy()}>
          <Copy size={13} aria-hidden="true" /> Copy
        </button>
        {copied && <span role="status">{copied}</span>}
      </div>
      <p className="help-p">Log in once in a terminal; HiveMind never stores tokens.</p>
    </>
  );
}
