import type { DatabaseSync } from "node:sqlite";

export interface PreviewTrack {
  uri: string;
  name: string;
  artists: string[];
  source: "library" | "catalog";
}

export interface PlaylistPreview {
  preview_id: string;
  action: "create" | "add";
  account_id: string;
  name: string;
  description: string;
  public: boolean;
  playlist_id: string | null;
  playlist_url: string | null;
  tracks: PreviewTrack[];
  duplicates: { index: number; uri: string; first_index: number }[];
  invalid: { index: number; uri: string; reason: string }[];
  created_at: number;
  expires_at: number;
  library_synced_at: string | null;
}

export interface CommitResult {
  status:
    | "committed"
    | "failed"
    | "partial_failure"
    | "uncertain"
    | "in_progress";
  preview_id: string;
  playlist_id: string | null;
  playlist_url: string | null;
  added_count: number;
  added_uris: string[];
  failed_uris: string[];
  uncertain_uris: string[];
  not_attempted_uris: string[];
  message: string;
}

type State = "pending" | "committing" | "finished";
export interface StoredPreview {
  preview: PlaylistPreview;
  state: State;
  result: CommitResult | null;
  pid: number | null;
}

/** Persist claimed tokens before any remote write; never release them for retry. */
export class PreviewStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS playlist_previews (
      preview_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'committing', 'finished')),
      pid INTEGER,
      result TEXT
    )`);
  }

  save(preview: PlaylistPreview): void {
    this.database
      .prepare(`INSERT INTO playlist_previews
      (preview_id, payload, expires_at, state) VALUES (?, ?, ?, 'pending')`)
      .run(preview.preview_id, JSON.stringify(preview), preview.expires_at);
  }

  get(id: string): StoredPreview | null {
    const row = this.database
      .prepare("SELECT * FROM playlist_previews WHERE preview_id = ?")
      .get(id);
    return row
      ? {
          preview: JSON.parse(String(row.payload)) as PlaylistPreview,
          state: row.state as State,
          result:
            row.result === null
              ? null
              : (JSON.parse(String(row.result)) as CommitResult),
          pid: row.pid === null ? null : Number(row.pid),
        }
      : null;
  }

  claim(id: string, now: number, result: CommitResult): boolean {
    return (
      this.database
        .prepare(`UPDATE playlist_previews
      SET state = 'committing', pid = ?, result = ?
      WHERE preview_id = ? AND state = 'pending' AND expires_at > ?`)
        .run(process.pid, JSON.stringify(result), id, now).changes === 1
    );
  }

  progress(id: string, result: CommitResult, finished = false): void {
    this.database
      .prepare(
        "UPDATE playlist_previews SET state = ?, result = ? WHERE preview_id = ? AND state = 'committing'",
      )
      .run(finished ? "finished" : "committing", JSON.stringify(result), id);
  }
}
