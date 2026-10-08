/** Events invalidate snapshots; they never overwrite authoritative state. */
export class SnapshotReconciler {
  private readonly seen = new Set<string>();
  private dirty = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private readonly fetchSnapshot: () => Promise<void>,
    private readonly failed: (error: unknown) => void,
    private readonly debounceMs = 120,
  ) {}

  invalidate(eventId?: string): void {
    if (this.disposed || (eventId && this.seen.has(eventId))) return;
    if (eventId) {
      this.seen.add(eventId);
      if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    }
    this.dirty = true;
    if (!this.running && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.debounceMs);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        try {
          await this.fetchSnapshot();
        } catch (error) {
          this.failed(error);
          break;
        }
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.seen.clear();
  }
}
