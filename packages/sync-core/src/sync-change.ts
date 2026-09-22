export type RemoteGeneration = string;

export type RemoteChangeSource = "obsidian" | "vault" | "unknown";
export type RemoteChangeKind = "upsert" | "delete" | "unknown";

/** A bounded diagnostic hint; it never changes Hub correctness semantics. */
export type RemoteChangeHint = {
  source?: RemoteChangeSource;
  kind?: RemoteChangeKind;
  writerId?: string;
  pathHash?: string;
};

export type MarkRemoteDirtyRequest = RemoteChangeHint & {
  channel: string;
};

export type MarkRemoteDirtyResult = { generation: RemoteGeneration };
