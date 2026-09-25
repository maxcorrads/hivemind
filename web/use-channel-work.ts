import { useEffect, useState } from 'react';
import type { ChannelTaskPage } from '../src/shared/tasks.ts';
import type { Channel } from '../src/shared/types.ts';
import { api } from './api.ts';

type Keyed<T> = { channelId: string; value: T };

/** The selected channel's tasks, for the Tasks tab and its count. They reload on `taskTick` (task and room events of this channel). */
export function useChannelWork(channel: Channel | undefined, taskTick: number) {
  const [tasks, setTasks] = useState<Keyed<ChannelTaskPage> | null>(null);
  const [error, setError] = useState<Keyed<string> | null>(null);
  const id = channel?.id;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    api.channelTasks(id, controller.signal).then(value => setTasks({ channelId: id, value })).catch(reason => {
      if ((reason as Error)?.name !== 'AbortError') setError({ channelId: id, value: String((reason as Error)?.message ?? reason) });
    });
    return () => controller.abort();
  }, [id, taskTick]);

  return {
    tasks: tasks && tasks.channelId === id ? tasks.value : null,
    error: error && error.channelId === id ? error.value : null,
  };
}
