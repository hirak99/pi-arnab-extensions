export type BufferedConsumer<T> = (value: T) => void | Promise<void>;

interface Entry<T> {
  value: T;
  complete: () => void;
}

/**
 * A transport-owned FIFO whose consumer can be replaced during /reload.
 * Listeners stay attached while runtime callbacks detach; events buffer until
 * the replacement consumer binds. No old-runtime Promise chain is carried.
 */
export class ReloadDispatcher<T> {
  private consumer: BufferedConsumer<T> | undefined;
  private queue: Entry<T>[] = [];
  private running = false;
  private disposed = false;

  constructor(private readonly capacity = 1_000) {}

  publish(value: T): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.queue.length >= this.capacity) {
      this.queue.shift()?.complete();
      console.error("[pi-discord-remote] Reload handoff buffer overflow; dropped oldest event");
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ value, complete: resolve });
      void this.pump();
    });
  }

  bind(consumer: BufferedConsumer<T>): void {
    if (this.disposed) return;
    this.consumer = consumer;
    void this.pump();
  }

  detach(): void {
    this.consumer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.consumer = undefined;
    for (const entry of this.queue.splice(0)) entry.complete();
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed || this.consumer === undefined) return;
    this.running = true;
    try {
      while (!this.disposed && this.consumer !== undefined && this.queue.length > 0) {
        const entry = this.queue.shift()!;
        const consumer = this.consumer;
        try {
          await consumer(entry.value);
        } catch (error) {
          console.error("[pi-discord-remote] Reload handoff consumer failed:", error);
        } finally {
          entry.complete();
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.disposed && this.consumer !== undefined && this.queue.length > 0) void this.pump();
  }
}
