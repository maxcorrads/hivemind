/** One owner, with wake-ups retained across await/finally boundaries. */
export class CoalescingPump {
  private requested = false;
  private stopped = false;
  private task: Promise<void> | null = null;

  constructor(private readonly run: () => Promise<void>, private readonly failed: (error: unknown) => void) {}

  wake(): void {
    if (this.stopped) return;
    this.requested = true;
    if (this.task) return;
    this.task = Promise.resolve().then(async () => {
      while (this.requested && !this.stopped) {
        this.requested = false;
        await this.run();
      }
    }).catch(error => this.failed(error)).finally(() => {
      this.task = null;
      // A wake may arrive after the last loop check but before this cleanup.
      if (this.requested && !this.stopped) this.wake();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.requested = false;
    await this.task;
  }
}
