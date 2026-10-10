import type { ScreenChange, ScreenPort, ScreenSnapshot, ScreenWriteOptions } from "@mineral/textui";

/** The room owns persistence and CAS; this adapter never creates a second screen database. */
export class HotScreenPort implements ScreenPort {
  private readonly listeners = new Set<(change: ScreenChange) => void>();

  constructor(
    private readonly id: string,
    private readonly signal: AbortSignal,
    private readonly read: () => Promise<ScreenSnapshot>,
    private readonly write: (text: string, options: ScreenWriteOptions) => Promise<ScreenSnapshot>,
  ) {}

  private check(id: string): void {
    if (id !== this.id || this.signal.aborted) throw new Error("Room app is no longer active");
  }

  async getScreen(id: string): Promise<ScreenSnapshot> {
    this.check(id);
    const snapshot = await this.read();
    this.check(id);
    return snapshot;
  }

  async setScreen(id: string, text: string, options: ScreenWriteOptions): Promise<ScreenSnapshot> {
    this.check(id);
    const before = await this.getScreen(id);
    const after = await this.write(text, options);
    if (after.revision !== before.revision) this.notify({ before, after, origin: options.origin });
    return after;
  }

  async onScreenChange(id: string, listener: (change: ScreenChange) => void): Promise<() => void> {
    this.check(id);
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  notify(change: ScreenChange): void {
    if (!this.signal.aborted) for (const listener of this.listeners) listener(change);
  }
}
