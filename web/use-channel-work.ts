import { useEffect, useState } from 'react';
import type { DecisionView } from '../src/shared/decisions.ts';
import type { ChannelTaskPage } from '../src/shared/tasks.ts';
import type { Channel } from '../src/shared/types.ts';
import { api } from './api.ts';

type Keyed<T> = { channelId: string; value: T };

/**
 * The selected channel's tasks and Human decisions, for the channel tabs and their counts. Tasks reload on
 * `taskTick` (task and room events of this channel), decisions on `decisionTick`; answers from a card apply at once.
 */
export function useChannelWork(channel: Channel | undefined, taskTick: number, decisionTick: number) {
  const [tasks, setTasks] = useState<Keyed<ChannelTaskPage> | null>(null);
  const [decisions, setDecisions] = useState<Keyed<DecisionView[]> | null>(null);
  const [error, setError] = useState<Keyed<string> | null>(null);
  const id = channel?.id, project = channel?.project;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    api.channelTasks(id, controller.signal).then(value => setTasks({ channelId: id, value })).catch(reason => {
      if ((reason as Error)?.name !== 'AbortError') setError({ channelId: id, value: String((reason as Error)?.message ?? reason) });
    });
    return () => controller.abort();
  }, [id, taskTick]);

  useEffect(() => {
    if (!id || !project) return;
    const controller = new AbortController();
    // The queue is per project (bounded to the 100 most relevant requests); this channel keeps its own.
    api.decisions(project, true, controller.signal)
      .then(page => setDecisions({ channelId: id, value: page.items.filter(item => item.channelId === id) }))
      .catch(reason => {
        if ((reason as Error)?.name !== 'AbortError') setError({ channelId: id, value: String((reason as Error)?.message ?? reason) });
      });
    return () => controller.abort();
  }, [id, project, decisionTick]);

  const answered = (updated: DecisionView) => setDecisions(current => current && current.channelId === updated.channelId
    ? { ...current, value: current.value.map(item => item.id === updated.id ? updated : item) } : current);

  return {
    tasks: tasks && tasks.channelId === id ? tasks.value : null,
    decisions: decisions && decisions.channelId === id ? decisions.value : null,
    error: error && error.channelId === id ? error.value : null,
    answered,
  };
}
