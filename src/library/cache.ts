import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { CONFIG_DIRECTORY } from "../auth/config.js";
import type {
  LastfmDiscoveryCache,
  LastfmLookup,
  TagEvidence,
} from "../lastfm/types.js";
import { normalizeTag } from "../lastfm/types.js";
import { PreviewStore } from "../playlist/store.js";
import type { CatalogItem } from "../spotify/catalog.js";

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
  tags: TagEvidence[];
}
export interface LibraryFilters {
  genre?: string | undefined;
  artist?: string | undefined;
  year?: number | undefined;
  added_after?: string | undefined;
  limit: number;
  offset: number;
  uri?: string | undefined;
  tag?: string | undefined;
  tags?: string[] | undefined;
  tag_level?: "track" | "artist" | "any" | undefined;
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
        CREATE TABLE IF NOT EXISTS lastfm_lookups (
          cache_key TEXT PRIMARY KEY, level TEXT NOT NULL CHECK (level IN ('track', 'artist')),
          artist TEXT NOT NULL, title TEXT, tags TEXT NOT NULL, source_url TEXT NOT NULL,
          fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, not_found INTEGER NOT NULL, allow_stale INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS lastfm_artist_links (
          artist_id TEXT PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
          lookup_key TEXT NOT NULL REFERENCES lastfm_lookups(cache_key)
        );
        CREATE TABLE IF NOT EXISTS lastfm_track_links (
          track_uri TEXT PRIMARY KEY REFERENCES tracks(uri) ON DELETE CASCADE,
          lookup_key TEXT NOT NULL REFERENCES lastfm_lookups(cache_key)
        );
        CREATE TABLE IF NOT EXISTS lastfm_discovery (
          cache_key TEXT PRIMARY KEY, candidates TEXT NOT NULL, source_url TEXT NOT NULL,
          fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        const columns = database
          .prepare("PRAGMA table_info(lastfm_lookups)")
          .all();
        if (!columns.some((column) => column.name === "allow_stale"))
          database.exec(
            "ALTER TABLE lastfm_lookups ADD COLUMN allow_stale INTEGER NOT NULL DEFAULT 0",
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return new LibraryCache(database, path);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  playlistPreviews(): PreviewStore {
    return new PreviewStore(this.database);
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
          "A library sync or enrichment is already running. Wait for it to finish, then retry.",
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

  readLastfmLookup(key: string, now = Date.now()): LastfmLookup | null {
    const row = this.database
      .prepare(
        "SELECT * FROM lastfm_lookups WHERE cache_key = ? AND expires_at > ?",
      )
      .get(key, now);
    return row ? this.lookupFromRow(row) : null;
  }

  enrichmentArtists(): { id: string; name: string }[] {
    return this.database
      .prepare(`SELECT DISTINCT a.id, a.name FROM artists a
      JOIN track_artists ta ON ta.artist_id = a.id ORDER BY a.name, a.id`)
      .all()
      .map((row) => ({ id: String(row.id), name: String(row.name) }));
  }

  deleteLastfmLookup(key: string): void {
    this.transaction(() => {
      this.database
        .prepare("DELETE FROM lastfm_artist_links WHERE lookup_key = ?")
        .run(key);
      this.database
        .prepare("DELETE FROM lastfm_track_links WHERE lookup_key = ?")
        .run(key);
      this.database
        .prepare("DELETE FROM lastfm_lookups WHERE cache_key = ?")
        .run(key);
    });
  }

  lastfmStorageBytes(): number {
    return Number(
      this.database
        .prepare(`SELECT
      (SELECT COALESCE(SUM(length(CAST(tags AS BLOB)) + length(CAST(artist AS BLOB)) +
        COALESCE(length(CAST(title AS BLOB)), 0) + length(CAST(source_url AS BLOB))), 0) FROM lastfm_lookups) +
      (SELECT COALESCE(SUM(length(CAST(candidates AS BLOB)) + length(CAST(source_url AS BLOB))), 0)
        FROM lastfm_discovery) AS bytes`)
        .get()?.bytes ?? 0,
    );
  }

  private checkLastfmSpace(
    table: "lastfm_lookups" | "lastfm_discovery",
    key: string,
    bytes: number,
  ): void {
    const columns =
      table === "lastfm_lookups"
        ? ["tags", "artist", "title", "source_url"]
        : ["candidates", "source_url"];
    const expression = columns
      .map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`)
      .join(" + ");
    const oldBytes = Number(
      this.database
        .prepare(
          `SELECT ${expression} AS bytes FROM ${table} WHERE cache_key = ?`,
        )
        .get(key)?.bytes ?? 0,
    );
    if (this.lastfmStorageBytes() - oldBytes + bytes > 90_000_000)
      throw new Error(
        "Last.fm cache reached its 90 MB local budget. Stop enrichment and review retained data before continuing.",
      );
  }

  readLastfmDiscovery(
    key: string,
    now = Date.now(),
  ): LastfmDiscoveryCache | null {
    const row = this.database
      .prepare(
        "SELECT * FROM lastfm_discovery WHERE cache_key = ? AND expires_at > ?",
      )
      .get(key, now);
    return row
      ? {
          key,
          candidates: JSON.parse(String(row.candidates)),
          sourceUrl: String(row.source_url),
          fetchedAt: Number(row.fetched_at),
          expiresAt: Number(row.expires_at),
        }
      : null;
  }

  saveLastfmDiscovery(value: LastfmDiscoveryCache): void {
    const candidates = JSON.stringify(value.candidates);
    this.transaction(() => {
      this.checkLastfmSpace(
        "lastfm_discovery",
        value.key,
        Buffer.byteLength(candidates + value.sourceUrl),
      );
      this.database
        .prepare(`INSERT INTO lastfm_discovery (cache_key, candidates, source_url, fetched_at, expires_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET candidates = excluded.candidates,
        source_url = excluded.source_url, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`)
        .run(
          value.key,
          candidates,
          value.sourceUrl,
          value.fetchedAt,
          value.expiresAt,
        );
    });
  }

  identityTracks(): CatalogItem[] {
    const artists = new Map<string, string[]>();
    const rows = this.database
      .prepare(
        `SELECT ta.track_uri, a.name FROM track_artists ta JOIN artists a ON a.id = ta.artist_id ORDER BY ta.track_uri, ta.position`,
      )
      .all();
    for (const row of rows) {
      const uri = String(row.track_uri);
      const names = artists.get(uri) ?? [];
      names.push(String(row.name));
      artists.set(uri, names);
    }
    return this.database
      .prepare(
        "SELECT uri, title, album, year FROM tracks ORDER BY added_at DESC, uri ASC",
      )
      .all()
      .map((row) => ({
        type: "track",
        uri: String(row.uri),
        name: String(row.title),
        artists: artists.get(String(row.uri)) ?? [],
        album: String(row.album),
        year: row.year === null ? null : Number(row.year),
      }));
  }

  private lookupFromRow(row: Record<string, unknown>): LastfmLookup {
    return {
      key: String(row.cache_key),
      level: row.level === "track" ? "track" : "artist",
      artist: String(row.artist),
      title: row.title === null ? null : String(row.title),
      tags: JSON.parse(String(row.tags)) as LastfmLookup["tags"],
      sourceUrl: String(row.source_url),
      fetchedAt: Number(row.fetched_at),
      expiresAt: Number(row.expires_at),
      notFound: Number(row.not_found) === 1,
      allowStale: Number(row.allow_stale) === 1,
    };
  }

  saveLastfmLookup(lookup: LastfmLookup): void {
    const tags = JSON.stringify(lookup.tags);
    this.transaction(() => {
      this.checkLastfmSpace(
        "lastfm_lookups",
        lookup.key,
        Buffer.byteLength(
          tags + lookup.artist + (lookup.title ?? "") + lookup.sourceUrl,
        ),
      );
      this.database
        .prepare(`INSERT INTO lastfm_lookups
        (cache_key, level, artist, title, tags, source_url, fetched_at, expires_at, not_found, allow_stale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET
        artist = excluded.artist, title = excluded.title, tags = excluded.tags, source_url = excluded.source_url,
        fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, not_found = excluded.not_found, allow_stale = excluded.allow_stale`)
        .run(
          lookup.key,
          lookup.level,
          lookup.artist,
          lookup.title,
          tags,
          lookup.sourceUrl,
          lookup.fetchedAt,
          lookup.expiresAt,
          Number(lookup.notFound),
          Number(lookup.allowStale === true),
        );
    });
  }

  linkLastfmArtist(artistId: string, key: string): void {
    this.database
      .prepare(`INSERT INTO lastfm_artist_links (artist_id, lookup_key) VALUES (?, ?)
      ON CONFLICT(artist_id) DO UPDATE SET lookup_key = excluded.lookup_key`)
      .run(artistId, key);
  }

  linkLastfmTrack(uri: string, key: string): void {
    this.database
      .prepare(`INSERT INTO lastfm_track_links (track_uri, lookup_key) VALUES (?, ?)
      ON CONFLICT(track_uri) DO UPDATE SET lookup_key = excluded.lookup_key`)
      .run(uri, key);
  }

  private tagsForTrack(uri: string, now: number): TagEvidence[] {
    const rows = this.database
      .prepare(`SELECT DISTINCT l.* FROM lastfm_lookups l WHERE (l.expires_at > ? OR l.allow_stale = 1) AND
      (l.cache_key IN (SELECT lookup_key FROM lastfm_track_links WHERE track_uri = ?)
       OR l.cache_key IN (SELECT a.lookup_key FROM lastfm_artist_links a JOIN track_artists ta ON ta.artist_id = a.artist_id WHERE ta.track_uri = ?))
      ORDER BY l.level DESC, l.fetched_at DESC`)
      .all(now, uri, uri);
    return rows.flatMap((row) => {
      const lookup = this.lookupFromRow(row);
      return lookup.tags.map((tag) => ({
        ...tag,
        source: "Last.fm" as const,
        level: lookup.level,
        source_url: lookup.sourceUrl,
        fetched_at: new Date(lookup.fetchedAt).toISOString(),
        expires_at: new Date(lookup.expiresAt).toISOString(),
        stale: lookup.expiresAt <= now,
      }));
    });
  }

  lastfmCoverage(now = Date.now()) {
    const tracks = this.database
      .prepare(`SELECT t.uri, l.expires_at, l.allow_stale, json_array_length(l.tags) AS tag_count
      FROM tracks t LEFT JOIN lastfm_track_links a ON a.track_uri = t.uri
      LEFT JOIN lastfm_lookups l ON l.cache_key = a.lookup_key`)
      .all();
    const artists = this.database
      .prepare(`SELECT DISTINCT ar.id, l.expires_at, l.allow_stale, json_array_length(l.tags) AS tag_count
      FROM artists ar JOIN track_artists ta ON ta.artist_id = ar.id
      LEFT JOIN lastfm_artist_links a ON a.artist_id = ar.id LEFT JOIN lastfm_lookups l ON l.cache_key = a.lookup_key`)
      .all();
    const associations = this.database
      .prepare(`SELECT ta.track_uri AS uri, l.expires_at, l.allow_stale, json_array_length(l.tags) AS tag_count
      FROM track_artists ta JOIN lastfm_artist_links a ON a.artist_id = ta.artist_id
      JOIN lastfm_lookups l ON l.cache_key = a.lookup_key`)
      .all();
    const summary = (rows: Record<string, unknown>[]) => {
      const recorded = rows.filter((row) => row.expires_at !== null);
      return {
        total: rows.length,
        recorded: recorded.length,
        fresh: recorded.filter((row) => Number(row.expires_at) > now).length,
        stale: recorded.filter((row) => Number(row.expires_at) <= now).length,
        empty: recorded.filter((row) => Number(row.tag_count) === 0).length,
        unprocessed: rows.length - recorded.length,
      };
    };
    const tagged = (rows: Record<string, unknown>[], fresh: boolean) =>
      new Set(
        rows
          .filter(
            (row) =>
              row.expires_at !== null &&
              Number(row.tag_count) > 0 &&
              (fresh
                ? Number(row.expires_at) > now
                : Number(row.expires_at) <= now &&
                  Number(row.allow_stale) === 1),
          )
          .map((row) => String(row.uri)),
      );
    const freshTrack = tagged(tracks, true),
      staleTrack = tagged(tracks, false);
    const freshArtist = tagged(associations, true),
      staleArtist = tagged(associations, false);
    const trackCount = new Set([...freshTrack, ...staleTrack]).size;
    const artistCount = new Set([...freshArtist, ...staleArtist]).size;
    const percent = (count: number) =>
      tracks.length ? Math.round((count / tracks.length) * 1000) / 10 : 0;
    return {
      total_tracks: tracks.length,
      tracks_with_track_tags: trackCount,
      tracks_with_artist_tags: artistCount,
      tracks_with_fresh_track_tags: freshTrack.size,
      tracks_with_stale_track_tags: staleTrack.size,
      tracks_with_fresh_artist_tags: freshArtist.size,
      tracks_with_stale_artist_tags: staleArtist.size,
      track_tag_coverage_percent: percent(trackCount),
      artist_tag_coverage_percent: percent(artistCount),
      track_lookups: summary(tracks),
      artist_lookups: summary(artists),
    };
  }

  query(
    filters: LibraryFilters,
    now = Date.now(),
  ): { total: number; tracks: LibraryTrack[] } {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (filters.uri) {
      conditions.push("t.uri = ?");
      values.push(filters.uri);
    }
    for (const filterTag of filters.tags ??
      (filters.tag ? [filters.tag] : [])) {
      const branches: string[] = [];
      if (filters.tag_level !== "artist") {
        branches.push(`EXISTS (SELECT 1 FROM lastfm_track_links a JOIN lastfm_lookups l ON l.cache_key = a.lookup_key,
          json_each(l.tags) tag WHERE a.track_uri = t.uri AND (l.expires_at > ? OR l.allow_stale = 1) AND instr(json_extract(tag.value, '$.normalized'), ?) > 0)`);
        values.push(now, normalizeTag(filterTag));
      }
      if (filters.tag_level !== "track") {
        branches.push(`EXISTS (SELECT 1 FROM track_artists ta JOIN lastfm_artist_links a ON a.artist_id = ta.artist_id
          JOIN lastfm_lookups l ON l.cache_key = a.lookup_key, json_each(l.tags) tag
          WHERE ta.track_uri = t.uri AND (l.expires_at > ? OR l.allow_stale = 1) AND instr(json_extract(tag.value, '$.normalized'), ?) > 0)`);
        values.push(now, normalizeTag(filterTag));
      }
      conditions.push(`(${branches.join(" OR ")})`);
    }
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
        tags: this.tagsForTrack(String(row.uri), now),
      };
    });
    return { total, tracks };
  }
}
