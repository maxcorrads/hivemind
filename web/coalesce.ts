export type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

const browserTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Leading and trailing throttle for realtime bursts: the first request runs at
 * once, and every further request inside the `ms` window collapses into a single
 * run when the window ends.
 */
export function createThrottle(run: () => void, ms: number, timers: Timers = browserTimers) {
  let timer: unknown = null;
  let pending = false;
  const open = () => {
    timer = timers.set(() => {
      timer = null;
      if (!pending) return;
      pending = false;
      run();
      open();
    }, ms);
  };
  return {
    request() {
      if (timer !== null) {
        pending = true;
        return;
      }
      run();
      open();
    },
    cancel() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      pending = false;
    },
  };
}

/** Collapses a burst of state updaters into one setState per throttle window, applied in arrival order. */
export function createUpdateBatch<T>(setState: (update: (value: T) => T) => void, ms: number, timers: Timers = browserTimers) {
  let queue: Array<(value: T) => T> = [];
  const throttle = createThrottle(() => {
    const updates = queue;
    queue = [];
    if (updates.length) setState((value) => updates.reduce((current, update) => update(current), value));
  }, ms, timers);
  return {
    push(update: (value: T) => T) {
      queue.push(update);
      throttle.request();
    },
    /** Drops queued updates, e.g. when a fresh snapshot supersedes them. */
    cancel() {
      queue = [];
      throttle.cancel();
    },
  };
}
