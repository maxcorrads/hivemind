import {
  BODY_MAX,
  WAIT_NEXT,
  type Agent,
  type Message,
  type WaitControlItem,
  type WaitMailItem,
  type WaitResult,
} from "../shared/types.ts";

export function packWait(
  actor: Agent,
  messages: Message[],
  more: number,
  compact: boolean,
  label: (channelId: string) => string,
): WaitResult {
  const controlMsgs = messages.filter((m) => m.kind === "control");
  const rest = messages.filter((m) => m.kind !== "control");
  const mentions = rest.filter((m) => m.mentions.includes(actor.id));
  const other = rest.filter((m) => !m.mentions.includes(actor.id));
  const you = {
    name: actor.name,
    role: actor.role,
    seniority: actor.seniority,
    focus: actor.focus?.slice(0, 512) ?? null,
    online: actor.online,
    project: actor.project,
  };

  if (!compact) {
    return {
      idle: messages.length === 0,
      next: WAIT_NEXT,
      you,
      control: controlMsgs,
      mentions,
      messages: other,
      more,
    };
  }

  const control: WaitControlItem[] = controlMsgs.map((m) => ({
    messageId: m.id,
    rootId: m.threadId ?? m.id,
    channelId: m.channelId,
    seq: m.seq,
    from: m.authorName,
    action: m.control ?? "clear_context",
    body: m.body.length > BODY_MAX ? m.body.slice(0, BODY_MAX) : m.body,
    ...(m.recovery ? { recovery: m.recovery } : {}),
  }));

  const full = (m: Message): WaitMailItem => ({
    messageId: m.id,
    rootId: m.threadId ?? m.id,
    seq: m.seq,
    channelId: m.channelId,
    ch: label(m.channelId),
    from: m.authorName,
    authorRole: m.authorRole,
    kind: m.kind,
    eventType: m.eventType,
    taskEvent: m.taskEvent,
    source: m.source,
    botEvent: m.botEvent,
    body: m.body.length > BODY_MAX ? m.body.slice(0, BODY_MAX) : m.body,
    threadId: m.threadId,
    attachments: m.attachments,
    attachmentCount: m.attachments?.length ?? 0,
    ...(m.recovery ? { recovery: m.recovery } : {}),
  });

  const digestLine = (items: Message[]): WaitMailItem => {
    const last = items[items.length - 1]!;
    const excerpt = last.body.replace(/\s+/g, " ").slice(0, 80);
    return {
      messageId: last.id,
      rootId: last.threadId ?? last.id,
      seq: last.seq,
      channelId: last.channelId,
      ch: label(last.channelId),
      from: last.authorName,
      authorRole: last.authorRole,
      kind: last.kind,
      eventType: last.eventType,
      source: last.source,
      botEvent: last.botEvent,
      excerpt,
      count: items.length,
      firstSeq: items[0]!.seq,
      lastSeq: last.seq,
      attachmentCount: items.reduce((n, m) => n + (m.attachments?.length ?? 0), 0),
      expand: { channel: last.channelId, messageIds: items.map(m => m.id) },
      threadId: last.threadId,
      attachments: last.attachments,
    };
  };

  let mail: WaitMailItem[];
  const conversations = new Set([...mentions, ...other].map((m) => m.channelId));
  if (actor.role === "brain" && conversations.size > 1) {
    const byScope = new Map<string, Message[]>();
    const instructions: Message[] = [];
    for (const m of other) {
      // Only explicitly non-actionable progress can be summarized. Untyped legacy
      // messages may contain a blocker/question anywhere in the body: keep them full.
      if (m.taskEvent || m.eventType !== "progress" || m.authorRole === "human" || m.authorRole === "brain" || m.attachments?.length || m.recovery) {
        instructions.push(m);
        continue;
      }
      // Unthreaded roots are distinct conversations, not an implicit shared task.
      const scope = JSON.stringify([m.channelId, m.threadId ?? m.id, m.authorId, m.kind]);
      const list = byScope.get(scope) ?? [];
      list.push(m);
      byScope.set(scope, list);
    }
    mail = [...mentions.map(full), ...instructions.map(full), ...[...byScope.values()].map(digestLine)]
      .sort((a, b) => a.seq - b.seq);
  } else {
    mail = [...mentions, ...other].map(full);
  }

  return {
    idle: messages.length === 0,
    next: WAIT_NEXT,
    you,
    control,
    mentions: [],
    messages: [],
    mail,
    more,
  };
}

/** Includes JSON escaping/pretty printing used by MCP and the CLI, not only HTTP JSON. */
export function waitWireBytes(result: WaitResult): number {
  const mcpText = JSON.stringify({ instruction: result.next, ...result }, null, 2);
  return Math.max(Buffer.byteLength(JSON.stringify(result)),
    Buffer.byteLength(JSON.stringify({ ...result, sessionId: "0".repeat(36) }, null, 2)),
    Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: mcpText }] })));
}
