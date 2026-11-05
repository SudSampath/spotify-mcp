import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { CONFIG_DIRECTORY } from "../auth/config.js";

export interface CachedArtist {
  id: string;
  name: string;
  genres: string[];
}
export interface CachedTrack {
  uri: string;
  id: string;
  title: string;
  album: string;
  year: number | null;
  addedAt: string;
  artists: { id: string; name: string }[];
}
export interface LibraryTrack extends CachedTrack {
  genres: string[];
}
export interface LibraryFilters {
  genre?: string | undefined;
  artist?: string | undefined;
  year?: number | undefined;
  added_after?: string | undefined;
  limit: number;
  offset: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class LibraryCache {
  private constructor(
    private readonly database: DatabaseSync,
    readonly path: string,
  ) {}

  static async open(directory = CONFIG_DIRECTORY): Promise<LibraryCache> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    // Lazy loading keeps SQLite's experimental warning out of server startup.
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(directory, "library.sqlite");
    const database = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS artists (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, genres TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracks (
          uri TEXT PRIMARY KEY, spotify_id TEXT NOT NULL, title TEXT NOT NULL,
          album TEXT NOT NULL, year INTEGER, added_at TEXT NOT NULL, full_run TEXT
        );
        CREATE TABLE IF NOT EXISTS track_artists (
          track_uri TEXT NOT NULL REFERENCES tracks(uri) ON DELETE CASCADE,
          artist_id TEXT NOT NULL REFERENCES artists(id), position INTEGER NOT NULL,
          PRIMARY KEY (track_uri, artist_id)
        );
        CREATE INDEX IF NOT EXISTS tracks_added ON tracks(added_at DESC, uri);
        CREATE INDEX IF NOT EXISTS artist_tracks ON track_artists(artist_id);
        CREATE TABLE IF NOT EXISTS sync_state (
          id INTEGER PRIMARY KEY CHECK (id = 1), completed_at TEXT NOT NULL, latest_added_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, pid INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS genre_support (
          id INTEGER PRIMARY KEY CHECK (id = 1), omitted_samples INTEGER NOT NULL,
          field_seen INTEGER NOT NULL
        );
      `);
      return new LibraryCache(database, path);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  acquireSync(owner: string): void {
    this.transaction(() => {
      const current = this.database
        .prepare("SELECT pid FROM sync_lock WHERE id = 1")
        .get();
      if (current && processAlive(Number(current.pid))) {
        throw new Error(
          "A library sync is already running. Wait for it to finish, then retry.",
        );
      }
      this.database
        .prepare(
          "INSERT OR REPLACE INTO sync_lock (id, owner, pid) VALUES (1, ?, ?)",
        )
        .run(owner, process.pid);
    });
  }

  releaseSync(owner: string): void {
    this.database
      .prepare("DELETE FROM sync_lock WHERE id = 1 AND owner = ?")
      .run(owner);
  }

  state(): { completedAt: string; latestAddedAt: string | null } | null {
    const row = this.database
      .prepare(
        "SELECT completed_at, latest_added_at FROM sync_state WHERE id = 1",
      )
      .get();
    return row
      ? {
          completedAt: String(row.completed_at),
          latestAddedAt:
            row.latest_added_at === null ? null : String(row.latest_added_at),
        }
      : null;
  }

  hasTrack(uri: string): boolean {
    return (
      this.database.prepare("SELECT 1 FROM tracks WHERE uri = ?").get(uri) !==
      undefined
    );
  }

  hasArtist(id: string): boolean {
    return (
      this.database.prepare("SELECT 1 FROM artists WHERE id = ?").get(id) !==
      undefined
    );
  }

  skipGenreLookups(): boolean {
    const row = this.database
      .prepare(
        "SELECT omitted_samples, field_seen FROM genre_support WHERE id = 1",
      )
      .get();
    return Boolean(
      row && Number(row.field_seen) === 0 && Number(row.omitted_samples) >= 3,
    );
  }

  recordGenreResponse(hasField: boolean): void {
    this.database
      .prepare(`INSERT INTO genre_support (id, omitted_samples, field_seen) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET omitted_samples = CASE WHEN excluded.field_seen = 1 THEN 0
        ELSE genre_support.omitted_samples + 1 END,
        field_seen = MAX(genre_support.field_seen, excluded.field_seen)`)
      .run(hasField ? 0 : 1, hasField ? 1 : 0);
  }

  genreCoverage() {
    const row = this.database
      .prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(EXISTS (SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
        WHERE ta.track_uri = t.uri AND json_array_length(a.genres) > 0)), 0) AS tagged FROM tracks t`)
      .get();
    return {
      total_tracks: Number(row?.total ?? 0),
      tracks_with_genres: Number(row?.tagged ?? 0),
      spotify_genres_omitted: this.skipGenreLookups(),
    };
  }

  saveArtist(artist: CachedArtist): void {
    this.database
      .prepare(`INSERT INTO artists (id, name, genres) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, genres = excluded.genres`)
      .run(artist.id, artist.name, JSON.stringify(artist.genres));
  }

  saveTracks(tracks: CachedTrack[], fullRun: string | null): number {
    return this.transaction(() => {
      let added = 0;
      const upsert =
        this.database.prepare(`INSERT INTO tracks (uri, spotify_id, title, album, year, added_at, full_run)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(uri) DO UPDATE SET
        spotify_id = excluded.spotify_id, title = excluded.title, album = excluded.album,
        year = excluded.year, added_at = excluded.added_at, full_run = COALESCE(excluded.full_run, tracks.full_run)`);
      const removeArtists = this.database.prepare(
        "DELETE FROM track_artists WHERE track_uri = ?",
      );
      const addArtist = this.database.prepare(
        "INSERT INTO track_artists (track_uri, artist_id, position) VALUES (?, ?, ?)",
      );
      for (const track of tracks) {
        if (!this.hasTrack(track.uri)) added++;
        upsert.run(
          track.uri,
          track.id,
          track.title,
          track.album,
          track.year,
          track.addedAt,
          fullRun,
        );
        removeArtists.run(track.uri);
        track.artists.forEach((artist, index) => {
          addArtist.run(track.uri, artist.id, index);
        });
      }
      return added;
    });
  }

  finishSync(
    completedAt: string,
    latestAddedAt: string | null,
    fullRun: string | null,
  ): number {
    return this.transaction(() => {
      const removed =
        fullRun === null
          ? 0
          : Number(
              this.database
                .prepare(
                  "DELETE FROM tracks WHERE full_run IS NULL OR full_run <> ?",
                )
                .run(fullRun).changes,
            );
      this.database
        .prepare(`INSERT INTO sync_state (id, completed_at, latest_added_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at, latest_added_at = excluded.latest_added_at`)
        .run(completedAt, latestAddedAt);
      return removed;
    });
  }

  count(): number {
    return Number(
      this.database.prepare("SELECT COUNT(*) AS total FROM tracks").get()
        ?.total ?? 0,
    );
  }

  query(filters: LibraryFilters): { total: number; tracks: LibraryTrack[] } {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (filters.genre) {
      conditions.push(`EXISTS (SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id,
        json_each(a.genres) genre WHERE ta.track_uri = t.uri AND instr(lower(genre.value), lower(?)) > 0)`);
      values.push(filters.genre);
    }
    if (filters.artist) {
      conditions.push(`EXISTS (SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
        WHERE ta.track_uri = t.uri AND instr(lower(a.name), lower(?)) > 0)`);
      values.push(filters.artist);
    }
    if (filters.year !== undefined) {
      conditions.push("t.year = ?");
      values.push(filters.year);
    }
    if (filters.added_after) {
      conditions.push("t.added_at > ?");
      values.push(filters.added_after);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = Number(
      this.database
        .prepare(`SELECT COUNT(*) AS total FROM tracks t ${where}`)
        .get(...values)?.total ?? 0,
    );
    const rows = this.database
      .prepare(
        `SELECT t.* FROM tracks t ${where} ORDER BY t.added_at DESC, t.uri ASC LIMIT ? OFFSET ?`,
      )
      .all(...values, filters.limit, filters.offset);
    const artistsQuery =
      this.database.prepare(`SELECT a.id, a.name, a.genres FROM track_artists ta
      JOIN artists a ON a.id = ta.artist_id WHERE ta.track_uri = ? ORDER BY ta.position`);
    const tracks = rows.map((row): LibraryTrack => {
      const artists = artistsQuery.all(String(row.uri));
      return {
        uri: String(row.uri),
        id: String(row.spotify_id),
        title: String(row.title),
        album: String(row.album),
        year: row.year === null ? null : Number(row.year),
        addedAt: String(row.added_at),
        artists: artists.map((artist) => ({
          id: String(artist.id),
          name: String(artist.name),
        })),
        genres: [
          ...new Set(
            artists.flatMap(
              (artist) => JSON.parse(String(artist.genres)) as string[],
            ),
          ),
        ],
      };
    });
    return { total, tracks };
  }
}
