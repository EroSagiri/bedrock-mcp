import type { ScreenPort } from "@mineral/textui";
import { workbenchApp } from "./workbench/app";
import { gamesApp } from "./games/app";

export interface RoomAppContext {
  screen: ScreenPort;
  screenId: string;
  signal: AbortSignal;
  index: { query(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>> };
  state?: { read(): Promise<unknown>; write(value: unknown): Promise<void> };
}

export interface RoomApp {
  name: string;
  run(context: RoomAppContext): Promise<void>;
}

export class RoomAppRegistry {
  private readonly apps = new Map<string, RoomApp>();

  register(app: RoomApp): this {
    if (!/^[a-z][a-z0-9-]*$/.test(app.name)) throw new Error("Invalid room app name");
    if (this.apps.has(app.name)) throw new Error("Duplicate room app name");
    this.apps.set(app.name, app);
    return this;
  }

  match(path: string): RoomApp | undefined {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    return filename.endsWith(".ui.md") ? this.apps.get(filename.slice(0, -6)) : undefined;
  }

  get(name: string): RoomApp | undefined { return this.apps.get(name); }
}

export const roomApps = new RoomAppRegistry().register(workbenchApp).register(gamesApp);
