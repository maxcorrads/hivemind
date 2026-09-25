import type { WaiterRegistry } from "./ports.ts";

export type Waiter = {
  wake: () => void;
  supersede: () => void;
  interrupt: () => void;
};

/** The single long-poll `wait` per agent. A newer wait or session supersedes the previous one. */
export class Waiters implements WaiterRegistry {
  private readonly byAgent = new Map<string, Waiter>();

  has(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  get(agentId: string): Waiter | undefined {
    return this.byAgent.get(agentId);
  }

  /** Installs `waiter`, superseding the agent's previous wait. */
  install(agentId: string, waiter: Waiter): void {
    this.byAgent.get(agentId)?.supersede();
    this.byAgent.set(agentId, waiter);
  }

  /** Removes `waiter` only if it is still the agent's current one. */
  release(agentId: string, waiter: Waiter): void {
    if (this.byAgent.get(agentId) === waiter) this.byAgent.delete(agentId);
  }

  wake(agentId: string): void {
    this.byAgent.get(agentId)?.wake();
  }

  supersede(agentId: string): void {
    this.byAgent.get(agentId)?.supersede();
  }

  /** Supersedes and forgets the agent's wait (the agent is being removed). */
  evict(agentId: string): void {
    this.byAgent.get(agentId)?.supersede();
    this.byAgent.delete(agentId);
  }

  /** Server shutdown interrupts transport, not identity/session ownership. */
  interruptAll(): void {
    for (const waiter of this.byAgent.values()) waiter.interrupt();
    this.byAgent.clear();
  }
}
