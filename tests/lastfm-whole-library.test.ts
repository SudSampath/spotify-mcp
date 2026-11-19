import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastfmClient, RequestBudget } from "../src/lastfm/client.js";
import { LastfmEnrichment, lastfmCacheKey } from "../src/lastfm/enrichment.js";
import { LibraryCache } from "../src/library/cache.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { jazzArtist, likedSong, rockArtist } from "./fixtures/library.js";

const run = promisify(execFile);
const cli = fileURLToPath(
  new URL("../dist/lastfm/enrich-all-cli.js", import.meta.url),
);
const day = 24 * 60 * 60 * 1000;
let directory: string;
let now: number;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
let lastfm: LastfmClient;
let enrichment: LastfmEnrichment;
const openCache = () => LibraryCache.open(directory);
const tagged = (control?: string) =>
  Response.json(
    {
      toptags: {
        tag: [
          {
            name: "Uptempo",
            count: "80",
            url: "https://www.last.fm/tag/uptempo",
          },
        ],
      },
    },
    control ? { headers: { "Cache-Control": control } } : undefined,
  );
async function seed(indexes = [1, 2, 3]) {
  const cache = await openCache();
  try {
    cache.saveArtist(jazzArtist);
    cache.saveArtist(rockArtist);
    const songs = indexes.map((index) =>
      likedSong(index, { artists: index === 3 ? [rockArtist] : [jazzArtist] }),
    );
    cache.saveTracks(
      songs.map((song) => ({
        uri: song.track.uri,
        id: song.track.id,
        title: song.track.name,
        album: song.track.album.name,
        year: 2020,
        addedAt: song.added_at,
        artists: song.track.artists,
      })),
      "synthetic-whole-library",
    );
    cache.finishSync(
      new Date(now).toISOString(),
      null,
      "synthetic-whole-library",
    );
  } finally {
    cache.close();
  }
}
async function coverage() {
  const cache = await openCache();
  try {
    return cache.lastfmCoverage(now);
  } finally {
    cache.close();
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-whole-library-"));
  now = Date.now();
  fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockImplementation(async () => tagged());
  sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  lastfm = new LastfmClient({
    fetch,
    sleep,
    getApiKey: async () => "a".repeat(32),
    minIntervalMs: 0,
    maxRetries: 1,
    now: () => now,
  });
  enrichment = new LastfmEnrichment(lastfm, openCache, () => now);
  await seed();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Whole-library enrichment", () => {
  it("Given an untagged library, when run, then records every artist before tracks and reports complete lookup coverage", async () => {
    const result = await enrichment.enrichAll();
    expect(result).toMatchObject({
      status: "complete",
      requests_made: 5,
      phases: {
        artist: { processed: 2, total: 2 },
        track: { processed: 3, total: 3 },
      },
      coverage: {
        total_tracks: 3,
        tracks_with_artist_tags: 3,
        tracks_with_track_tags: 3,
        artist_lookups: { total: 2, recorded: 2, fresh: 2, unprocessed: 0 },
        track_lookups: { recorded: 3, unprocessed: 0 },
        artist_tag_coverage_percent: 100,
        track_tag_coverage_percent: 100,
      },
    });
    expect(
      fetch.mock.calls.map((call) =>
        new URL(String(call[0])).searchParams.get("method"),
      ),
    ).toEqual([
      "artist.getTopTags",
      "artist.getTopTags",
      "track.getTopTags",
      "track.getTopTags",
      "track.getTopTags",
    ]);
    expect(fetch.mock.calls.every((call) => call[1]?.method === "GET")).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain("a".repeat(32));
  });

  it("Given a completed run, when rerun by a fresh service, then makes zero HTTP requests", async () => {
    await enrichment.enrichAll();
    fetch.mockClear();
    const result = await new LastfmEnrichment(
      lastfm,
      openCache,
      () => now,
    ).enrichAll();
    expect(result).toMatchObject({
      status: "complete",
      requests_made: 0,
      cache_hits: 5,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Given interruption after a saved track lookup, when rerun, then resumes without repeating finished artist or track requests", async () => {
    const abort = new AbortController();
    await expect(
      enrichment.enrichAll({
        signal: abort.signal,
        onProgress: async (progress) => {
          if (progress.phase === "track" && progress.processed === 1)
            abort.abort();
        },
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await coverage()).toMatchObject({
      artist_lookups: { recorded: 2 },
      track_lookups: { recorded: 1 },
    });
    const result = await enrichment.enrichAll();
    expect(result).toMatchObject({
      status: "complete",
      requests_made: 2,
      cache_hits: 3,
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("Given a bounded request budget, when exhausted after artists, then saves checkpoints and resumes the remaining tracks", async () => {
    expect(await enrichment.enrichAll({ request_budget: 2 })).toMatchObject({
      status: "budget_exhausted",
      requests_made: 2,
      phases: { artist: { processed: 2 }, track: { processed: 0 } },
    });
    expect(await enrichment.enrichAll({ request_budget: 3 })).toMatchObject({
      status: "complete",
      requests_made: 3,
      cache_hits: 2,
    });
  });

  it("Given twenty newly synced songs and one new artist, when rerun within expiry, then fetches only their new identities", async () => {
    await enrichment.enrichAll();
    await seed(Array.from({ length: 23 }, (_, index) => index + 1));
    const cache = await openCache();
    try {
      const artist = {
        id: "D".repeat(22),
        name: "New Synthetic Artist",
        genres: [],
      };
      cache.saveArtist(artist);
      const song = likedSong(4, { artists: [artist] });
      cache.saveTracks(
        [
          {
            uri: song.track.uri,
            id: song.track.id,
            title: song.track.name,
            album: song.track.album.name,
            year: 2020,
            addedAt: song.added_at,
            artists: song.track.artists,
          },
        ],
        "synthetic-new-song",
      );
    } finally {
      cache.close();
    }
    fetch.mockClear();
    expect(await enrichment.enrichAll()).toMatchObject({
      status: "complete",
      requests_made: 21,
      cache_hits: 5,
      coverage: {
        total_tracks: 23,
        artist_lookups: { recorded: 3 },
        track_lookups: { recorded: 23 },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(21);
  });

  it("Given confirmed empty lookups, when repeated before seven days, then records them without inventing tags or HTTP requests", async () => {
    fetch.mockImplementation(async () =>
      Response.json({ toptags: { tag: [] } }),
    );
    expect(await enrichment.enrichAll()).toMatchObject({
      status: "complete",
      empty_lookups: 5,
      coverage: {
        artist_lookups: { recorded: 2, empty: 2 },
        track_lookups: { recorded: 3, empty: 3 },
        tracks_with_track_tags: 0,
        tracks_with_artist_tags: 0,
      },
    });
    now += 7 * day - 1;
    expect((await enrichment.enrichAll()).requests_made).toBe(0);
    now++;
    expect((await enrichment.enrichAll()).requests_made).toBe(5);
  });

  it("Given HTTP 200 rate-limit code 29, when run, then backs off and continues with attempts counted", async () => {
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: 29, message: `key ${"a".repeat(32)}` },
        { headers: { "Retry-After": "2" } },
      ),
    );
    const result = await enrichment.enrichAll();
    expect(result).toMatchObject({ status: "complete", requests_made: 6 });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(JSON.stringify(result)).not.toContain("a".repeat(32));
  });

  it("Given an invalid-key error after completed artists, when fixed and rerun, then errors are not cached and artists are not repeated", async () => {
    fetch
      .mockResolvedValueOnce(tagged())
      .mockResolvedValueOnce(tagged())
      .mockResolvedValueOnce(
        Response.json({ error: 10, message: `bad ${"a".repeat(32)}` }),
      );
    await expect(enrichment.enrichAll()).rejects.toMatchObject({ code: 10 });
    expect(await coverage()).toMatchObject({
      artist_lookups: { recorded: 2 },
      track_lookups: { recorded: 0 },
    });
    expect(await enrichment.enrichAll()).toMatchObject({
      status: "complete",
      requests_made: 3,
      cache_hits: 2,
    });
  });

  it("Given another live sync/enrichment lock, when run, then refuses concurrent mutation while local reads still work", async () => {
    const cache = await openCache();
    cache.acquireSync("synthetic-other-job");
    try {
      await expect(enrichment.enrichAll()).rejects.toThrow(/already running/i);
      expect(cache.query({ limit: 1, offset: 0 }).total).toBe(3);
    } finally {
      cache.releaseSync("synthetic-other-job");
      cache.close();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Given no completed sync, when run, then asks for sync without HTTP", async () => {
    await rm(directory, { recursive: true, force: true });
    expect(await enrichment.enrichAll()).toMatchObject({
      status: "needs_sync",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Stale evidence and provider cache rules", () => {
  it("Given tags older than thirty days, when filtering, then returns permitted stale evidence with whole-library coverage", async () => {
    fetch
      .mockResolvedValueOnce(tagged())
      .mockResolvedValueOnce(Response.json({ toptags: { tag: [] } }))
      .mockResolvedValueOnce(Response.json({ toptags: { tag: [] } }));
    await enrichment.enrichAll({ scope: "track" });
    now += 30 * day;
    const cache = await openCache();
    try {
      const result = cache.query({ tag: "uptempo", limit: 1, offset: 0 }, now);
      expect(result.total).toBe(1);
      expect(result.tracks[0]?.tags[0]).toMatchObject({
        stale: true,
        source: "Last.fm",
        level: "track",
      });
      expect(cache.lastfmCoverage(now)).toMatchObject({
        total_tracks: 3,
        tracks_with_track_tags: 1,
        tracks_with_fresh_track_tags: 0,
        tracks_with_stale_track_tags: 1,
        track_lookups: { recorded: 3, stale: 3 },
      });
    } finally {
      cache.close();
    }
    const server = createServer(
      new SpotifyClient({ getAccessToken: async () => "synthetic", fetch }),
      openCache,
    );
    const client = new Client({
      name: "synthetic-stale-tag-test",
      version: "1.0.0",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      // The MCP tool uses the wall clock; advance it only for this local request.
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const result = await client.callTool({
          name: "get_library",
          arguments: { tag: "uptempo", limit: 1 },
        });
        expect(result.structuredContent).toMatchObject({
          total: 1,
          returned: 1,
          tag_coverage: { total_tracks: 3, tracks_with_stale_track_tags: 1 },
        });
        expect(JSON.stringify(result.content)).toContain("(stale)");
      } finally {
        clock.mockRestore();
      }
    } finally {
      await client.close();
      await server.close();
    }
    expect((await enrichment.enrichAll()).requests_made).toBe(5);
    expect(await coverage()).toMatchObject({
      tracks_with_stale_track_tags: 0,
      tracks_with_fresh_track_tags: 3,
    });
  });

  it.each(["max-age=1", "must-revalidate"])(
    "Given provider %s restrictions, when evidence expires, then does not serve stale tags",
    async (control) => {
      fetch.mockImplementation(async () => tagged(control));
      await enrichment.enrichAll();
      now += 31 * day;
      const cache = await openCache();
      try {
        expect(
          cache.query({ tag: "uptempo", limit: 10, offset: 0 }, now).total,
        ).toBe(0);
      } finally {
        cache.close();
      }
      expect((await enrichment.enrichAll()).requests_made).toBe(5);
    },
  );

  it("Given a fresh empty response replacing stale tags, when refreshed, then removes old positive tag matches", async () => {
    await enrichment.enrichAll();
    now += 30 * day;
    fetch.mockImplementation(async () =>
      Response.json({ toptags: { tag: [] } }),
    );
    await enrichment.enrichAll();
    expect(await coverage()).toMatchObject({
      tracks_with_track_tags: 0,
      tracks_with_artist_tags: 0,
      track_lookups: { recorded: 3, fresh: 3, empty: 3 },
    });
  });

  it.each(["no-store", "no-cache", "max-age=0"])(
    "Given a provider changes to %s, when refreshed, then deletes prior stale snapshots instead of retaining forbidden evidence",
    async (control) => {
      await enrichment.enrichAll();
      now += 30 * day;
      fetch.mockImplementation(async () => tagged(control));
      expect(await enrichment.enrichAll()).toMatchObject({
        status: "incomplete",
        uncacheable_lookups: 5,
      });
      expect(await coverage()).toMatchObject({
        tracks_with_track_tags: 0,
        tracks_with_artist_tags: 0,
        artist_lookups: { recorded: 0 },
        track_lookups: { recorded: 0 },
      });
    },
  );

  it("Given an old database without stored cache policy, when migrated, then preserves data but does not guess permission to reuse stale responses", async () => {
    await enrichment.enrichAll();
    const database = new DatabaseSync(join(directory, "library.sqlite"));
    database.exec("ALTER TABLE lastfm_lookups DROP COLUMN allow_stale");
    database.close();
    now += 30 * day;
    const cache = await openCache();
    try {
      expect(cache.lastfmCoverage(now).track_lookups.recorded).toBe(3);
      expect(
        cache.query({ tag: "uptempo", limit: 10, offset: 0 }, now).total,
      ).toBe(0);
    } finally {
      cache.close();
    }
    expect((await enrichment.enrichAll()).requests_made).toBe(5);
  });

  it("Given the local storage budget is exhausted, when saving metadata, then refuses the write without damaging existing entries", async () => {
    await enrichment.enrichAll();
    const cache = await openCache();
    try {
      expect(cache.lastfmStorageBytes()).toBeGreaterThan(0);
      const size = vi
        .spyOn(cache, "lastfmStorageBytes")
        .mockReturnValue(90_000_001);
      try {
        expect(() =>
          cache.saveLastfmLookup({
            key: lastfmCacheKey("artist", "Synthetic Extra", null),
            level: "artist",
            artist: "Synthetic Extra",
            title: null,
            tags: [],
            sourceUrl: "https://www.last.fm/music/Synthetic",
            fetchedAt: now,
            expiresAt: now + day,
            notFound: false,
          }),
        ).toThrow("90 MB");
      } finally {
        size.mockRestore();
      }
      expect(cache.lastfmCoverage(now).artist_lookups.recorded).toBe(2);
    } finally {
      cache.close();
    }
  });
});

describe("Enrichment CLI", () => {
  it("Given help or offline status, when invoked without credentials, then prints instructions or synthetic coverage without HTTP", async () => {
    const help = await run(process.execPath, [cli, "--help"], { env: {} });
    expect(help.stdout).toContain("--max-requests");
    const result = await run(
      process.execPath,
      [cli, "--status", "--data-dir", directory],
      { env: {} },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      event: "coverage",
      coverage: { total_tracks: 3, track_lookups: { recorded: 0 } },
    });
  });

  it("Given invalid arguments, when invoked, then rejects without echoing argument values", async () => {
    try {
      await run(
        process.execPath,
        [cli, "--scope", "synthetic-secret-argument"],
        { env: {} },
      );
      throw new Error("Expected command failure");
    } catch (error) {
      expect(error).toHaveProperty("code", 1);
      expect((error as { stderr: string }).stderr).toContain(
        "Invalid arguments",
      );
      expect((error as { stderr: string }).stderr).not.toContain(
        "synthetic-secret-argument",
      );
    }
  });

  it("Given a long rate-limit backoff, when interrupted, then cancels promptly without another HTTP request", async () => {
    const controller = new AbortController();
    fetch.mockResolvedValueOnce(
      Response.json({ error: 29 }, { headers: { "Retry-After": "600" } }),
    );
    const client = new LastfmClient({
      fetch,
      getApiKey: async () => "a".repeat(32),
      minIntervalMs: 0,
      maxRetries: 1,
    });
    const request = client.getTopTags("artist", "Synthetic", null, {
      budget: new RequestBudget(2),
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(request).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
