import { z } from 'zod';

export const traceMetadataSchema = z.object({
  traceId: z.string().uuid().optional(),
  causeMessageId: z.string().uuid().optional(),
}).strict();

export type TimelineRelation = {
  kind: 'explicit' | 'inferred';
  messageId: string;
};

export type TimelineMessageEvent = {
  kind: 'message';
  id: string;
  at: number;
  traceId: string;
  messageId: string;
  seq: number;
  authorId: string;
  authorName: string;
  authorRole: string;
  source: 'hive' | 'telegram' | 'bot';
  eventType: string | null;
  taskAction: string | null;
  relation: TimelineRelation | null;
  bodyBytes: number;
  bodySha256: string;
  references: { evidenceSeqs: number[]; artifactCount: number; checkCount: number };
};

export type TimelineDeliveryEvent = {
  kind: 'delivery';
  id: string;
  at: number;
  traceId: string;
  messageId: string;
  seq: number;
  agentId: string;
  agentName: string;
  agentRole: string;
  stage: 'offered' | 'acknowledged';
  deliveryId: string;
  attempt: number;
  wakeReason: string;
};

export type TimelineEvent = TimelineMessageEvent | TimelineDeliveryEvent;

export type TimelineView = {
  traceId: string;
  taskId: string | null;
  events: TimelineEvent[];
  truncated: boolean;
  warning: string;
};

export type RedactedTimelineEvent =
  | Omit<TimelineMessageEvent, 'authorId' | 'authorName' | 'authorRole'> & { actor: string }
  | Omit<TimelineDeliveryEvent, 'agentId' | 'agentName' | 'agentRole'> & { actor: string };

export type TimelineExport = {
  schemaVersion: 1;
  mode: 'fake-only';
  traceId: string;
  taskId: string | null;
  exportedAt: number;
  events: RedactedTimelineEvent[];
  truncated: boolean;
  redaction: {
    messageBodies: 'sha256+byte-length-only';
    actorNames: 'stable-role-aliases';
    secrets: 'not-included';
    artifacts: 'counts-and-evidence-seqs-only';
  };
};

export type ReplayResult = {
  traceId: string;
  taskId: string | null;
  finalTaskState: 'unknown' | 'sent' | 'accepted' | 'blocked' | 'result_submitted' | 'accepted_complete' | 'changes_requested';
  offered: number;
  acknowledged: number;
  duplicateMessageIds: string[];
  orphanAcknowledgements: string[];
  transitions: string[];
};

export function replayTimeline(input: TimelineExport): ReplayResult {
  if (input.schemaVersion !== 1 || input.mode !== 'fake-only') throw new Error('Unsupported timeline export');
  const seenMessages = new Set<string>(), duplicateMessageIds: string[] = [];
  const offered = new Set<string>(), orphanAcknowledgements: string[] = [], transitions: string[] = [];
  let finalTaskState: ReplayResult['finalTaskState'] = 'unknown', offeredCount = 0, acknowledged = 0;
  for (const event of input.events) {
    if (event.traceId !== input.traceId) throw new Error('Mixed trace export');
    if (event.kind === 'message') {
      if (seenMessages.has(event.messageId)) duplicateMessageIds.push(event.messageId);
      else seenMessages.add(event.messageId);
      if (event.taskAction) {
        transitions.push(event.taskAction);
        if (event.taskAction === 'assign' || event.taskAction === 'revise') finalTaskState = 'sent';
        else if (event.taskAction === 'accept') finalTaskState = 'accepted';
        else if (event.taskAction === 'block') finalTaskState = 'blocked';
        else if (event.taskAction === 'result') finalTaskState = 'result_submitted';
        else if (event.taskAction === 'review:accepted') finalTaskState = 'accepted_complete';
        else if (event.taskAction === 'review:changes_requested') finalTaskState = 'changes_requested';
      }
    } else if (event.stage === 'offered') {
      offeredCount++;
      offered.add(event.deliveryId + ':' + event.seq + ':' + event.actor);
    } else {
      acknowledged++;
      const key = event.deliveryId + ':' + event.seq + ':' + event.actor;
      if (!offered.has(key)) orphanAcknowledgements.push(key);
    }
  }
  return { traceId: input.traceId, taskId: input.taskId, finalTaskState, offered: offeredCount, acknowledged,
    duplicateMessageIds, orphanAcknowledgements, transitions };
}

export const TIMELINE_EVENT_LIMIT = 500;
export const TIMELINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TIMELINE_MAX_PROVENANCE_ROWS = 50_000;
export const TIMELINE_MAX_DELIVERY_ROWS = 100_000;
