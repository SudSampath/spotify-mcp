import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastfmClient } from "../src/lastfm/client.js";
import { LastfmConfigError } from "../src/lastfm/config.js";
import { LastfmEnrichment } from "../src/lastfm/enrichment.js";
import { LibraryCache } from "../src/library/cache.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { jazzArtist, likedSong, rockArtist } from "./fixtures/library.js";

let directory: string;
let client: Client;
let server: McpServer;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let spotifyFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let getApiKey: ReturnType<typeof vi.fn<() => Promise<string>>>;
let lastfm: LastfmClient;
const openCache = () => LibraryCache.open(directory);
const tagged = (name = "Breakbeat") =>
  Response.json({
    toptags: {
      tag: [
        {
          name,
          count: "80",
          url: `https://www.last.fm/tag/${encodeURIComponent(name)}`,
        },
      ],
    },
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-lastfm-enrichment-"));
  fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockRejectedValue(new Error("Unexpected mocked Last.fm request"));
  spotifyFetch = vi.fn<typeof globalThis.fetch>();
  spotifyFetch.mockRejectedValue(new Error("Unexpected Spotify request"));
  getApiKey = vi.fn<() => Promise<string>>();
  getApiKey.mockResolvedValue("a".repeat(32));
  lastfm = new LastfmClient({
    fetch,
    getApiKey,
    minIntervalMs: 0,
    maxRetries: 0,
  });
  server = createServer(
    new SpotifyClient({
      fetch: spotifyFetch,
      getAccessToken: async () => "synthetic-access",
    }),
    openCache,
    lastfm,
  );
  client = new Client({
    name: "synthetic-lastfm-enrichment-tests",
    version: "1.0.0",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
});
afterEach(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

async function seed(multiArtist = false) {
  const cache = await openCache();
  try {
    cache.saveArtist(jazzArtist);
    cache.saveArtist(rockArtist);
    const songs = [
      likedSong(3, {
        artists: multiArtist ? [jazzArtist, rockArtist] : [jazzArtist],
      }),
      likedSong(2),
      likedSong(1, { artists: [rockArtist] }),
    ];
    cache.saveTracks(
      songs.map((value) => ({
        uri: value.track.uri,
        id: value.track.id,
        title: value.track.name,
        album: value.track.album.name,
        year: 2020,
        addedAt: value.added_at,
        artists: value.track.artists,
      })),
      "synthetic-full-run",
    );
    cache.finishSync(
      new Date().toISOString(),
      songs[0]?.added_at ?? null,
      "synthetic-full-run",
    );
  } finally {
    cache.close();
  }
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  return {
    response,
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}
function text(value: Awaited<ReturnType<typeof client.callTool>>) {
  return (value.content as { text?: string }[])
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("Bounded library enrichment", () => {
  it("Given a selected artist batch, when enriched, then caches shared artist tags with provenance and supports local tag filtering", async () => {
    await seed();
    fetch.mockResolvedValueOnce(tagged());
    const { response, data } = await call("enrich_library", {
      limit: 1,
      request_budget: 1,
    });
    expect(response.isError).not.toBe(true);
    expect(data).toMatchObject({
      status: "complete",
      selected_tracks: 1,
      processed_tracks: 1,
      requests_made: 1,
      next_offset: 1,
      coverage: { tracks_with_artist_tags: 2, tracks_with_track_tags: 0 },
    });
    const filtered = await call("get_library", { tag: "BREAKBEAT" });
    expect(filtered.data).toMatchObject({ total: 2 });
    expect(text(filtered.response)).toContain("Last.fm artist: Breakbeat");
    expect(text(filtered.response)).toContain(likedSong(3).track.uri);
    expect(text(filtered.response)).not.toContain(likedSong(1).track.uri);
    expect(
      (await call("get_library", { genre: "breakbeat" })).data,
    ).toMatchObject({ total: 0 });
    expect(
      (await call("get_library", { tag: "breakbeat", tag_level: "track" }))
        .data,
    ).toMatchObject({ total: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spotifyFetch).not.toHaveBeenCalled();
  });
  it("Given a multi-artist track and one-request budget, when exhausted, then retries the same offset without skipping incomplete work", async () => {
    await seed(true);
    fetch.mockImplementation(async () => tagged());
    expect(
      (await call("enrich_library", { limit: 1, request_budget: 1 })).data,
    ).toMatchObject({
      status: "budget_exhausted",
      processed_tracks: 0,
      requests_made: 1,
      next_offset: 0,
    });
    expect(
      (await call("enrich_library", { limit: 1, request_budget: 1 })).data,
    ).toMatchObject({
      status: "complete",
      processed_tracks: 1,
      requests_made: 1,
      cache_hits: 1,
      next_offset: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("Given cached artist tags, when enrichment repeats, then makes no network requests", async () => {
    await seed();
    fetch.mockImplementation(async () => tagged());
    await call("enrich_library", { limit: 3 });
    fetch.mockClear();
    getApiKey.mockRejectedValue(new LastfmConfigError());
    expect((await call("enrich_library", { limit: 3 })).data).toMatchObject({
      requests_made: 0,
      processed_tracks: 3,
      cache_hits: 3,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Given no synced library, when enrichment is requested, then asks for sync without loading an API key", async () => {
    expect((await call("enrich_library")).data).toMatchObject({
      status: "needs_sync",
    });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Given a missing API key, when lookup fails, then existing Spotify/library tools and MCP remain usable", async () => {
    await seed();
    getApiKey.mockRejectedValue(new LastfmConfigError());
    const { response } = await call("enrich_library");
    expect(response.isError).toBe(true);
    expect(text(response)).toContain("lastfm:configure");
    expect((await call("get_library")).data).toMatchObject({ total: 3 });
    await expect(client.ping()).resolves.toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    expect(spotifyFetch).not.toHaveBeenCalled();
  });
});

it("Given no-store provider responses, when looked up, then returns evidence without persisting it", async () => {
  await seed();
  fetch.mockImplementation(async () =>
    Response.json(
      { toptags: { tag: [{ name: "Uptempo", count: 50 }] } },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
  expect(
    (await call("get_track_tags", { uri: likedSong(3).track.uri })).data,
  ).toMatchObject({ track: { cache_stored: false } });
  expect((await call("get_library", { tag: "uptempo" })).data).toMatchObject({
    total: 0,
  });
  await call("get_track_tags", { uri: likedSong(3).track.uri });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("Given a shorter provider cache lifetime, when it expires, then refreshes before the default TTL", async () => {
  let now = Date.now();
  const enrichment = new LastfmEnrichment(lastfm, openCache, () => now);
  fetch.mockImplementation(async () =>
    Response.json(
      { toptags: { tag: [{ name: "Jazz" }] } },
      { headers: { "Cache-Control": "max-age=60", Age: "10" } },
    ),
  );
  const input = {
    artist: "Synthetic Artist",
    title: "Synthetic Track",
    include_artist_fallback: false,
    request_budget: 2,
  };
  await enrichment.getTrackTags(input);
  now += 49_999;
  expect((await enrichment.getTrackTags(input)).track.cache_hit).toBe(true);
  now++;
  expect((await enrichment.getTrackTags(input)).track.cache_hit).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
});

describe("Track-specific evidence", () => {
  it("Given a cached URI, when track tags are requested, then links only that URI and preserves source, weights and times", async () => {
    await seed();
    fetch.mockResolvedValueOnce(tagged("Uptempo"));
    const { data } = await call("get_track_tags", {
      uri: likedSong(3).track.uri,
    });
    expect(data).toMatchObject({
      uri: likedSong(3).track.uri,
      requests_made: 1,
      artist_fallback: null,
      track: {
        source: "Last.fm",
        level: "track",
        status: "tagged",
        tags: [{ name: "Uptempo", normalized: "uptempo", count: 80 }],
        cache_hit: false,
      },
    });
    const filtered = await call("get_library", {
      tag: "uptempo",
      tag_level: "track",
    });
    expect(filtered.data).toMatchObject({ total: 1 });
    expect(text(filtered.response)).toContain("Last.fm track: Uptempo");
    expect(text(filtered.response)).toContain(likedSong(3).track.uri);
    expect(text(filtered.response)).not.toContain(likedSong(2).track.uri);
    expect(data).not.toHaveProperty("bpm");
    expect(data).not.toHaveProperty("beat_grid");
  });
  it("Given empty track tags and explicit fallback, when requested, then keeps artist evidence separate from track evidence", async () => {
    await seed();
    fetch
      .mockResolvedValueOnce(Response.json({ toptags: { tag: [] } }))
      .mockResolvedValueOnce(tagged("Upbeat"));
    const { data } = await call("get_track_tags", {
      uri: likedSong(3).track.uri,
      include_artist_fallback: true,
    });
    expect(data).toMatchObject({
      track: { level: "track", tags: [], status: "empty" },
      artist_fallback: { level: "artist", tags: [{ name: "Upbeat" }] },
    });
    expect(
      (await call("get_library", { tag: "upbeat", tag_level: "track" })).data,
    ).toMatchObject({ total: 0 });
    expect(
      (await call("get_library", { tag: "upbeat", tag_level: "artist" })).data,
    ).toMatchObject({ total: 2 });
  });
  it("Given one-request allowance and empty tags, when fallback would exceed budget, then reports it without another request", async () => {
    await seed();
    fetch.mockResolvedValueOnce(Response.json({ toptags: { tag: [] } }));
    expect(
      (
        await call("get_track_tags", {
          uri: likedSong(3).track.uri,
          include_artist_fallback: true,
          request_budget: 1,
        })
      ).data,
    ).toMatchObject({
      budget_exhausted: true,
      requests_made: 1,
      artist_fallback: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given a normalized equivalent name pair, when repeated, then uses the cached lookup without inventing a Spotify URI", async () => {
    fetch.mockResolvedValueOnce(tagged());
    await call("get_track_tags", {
      artist: "Synthetic Artist",
      title: "Synthetic Song",
    });
    const result = await call("get_track_tags", {
      artist: " synthetic   ARTIST ",
      title: "synthetic SONG",
    });
    expect(result.data).toMatchObject({
      requests_made: 0,
      track: { cache_hit: true },
    });
    expect(result.data).not.toHaveProperty("uri");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given a provider failure, when retried after recovery, then does not cache the error as empty tags", async () => {
    fetch
      .mockResolvedValueOnce(
        Response.json({ error: 10, message: "Synthetic bad key" }),
      )
      .mockResolvedValueOnce(tagged());
    expect(
      (await call("get_track_tags", { artist: "Synthetic", title: "Track" }))
        .response.isError,
    ).toBe(true);
    expect(
      (await call("get_track_tags", { artist: "Synthetic", title: "Track" }))
        .data,
    ).toMatchObject({ track: { status: "tagged" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    {},
    { uri: likedSong(3).track.uri, artist: "Synthetic", title: "Track" },
    { artist: "Synthetic" },
    { artist: "Synthetic", title: " " },
    { uri: "https://example.test/track" },
    { artist: "Synthetic", title: "Track", request_budget: 0 },
  ])(
    "Given invalid input %j, when requested, then rejects it before HTTP",
    async (args) => {
      expect((await call("get_track_tags", args)).response.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

it("Given positive and empty lookups, when TTLs expire, then refreshes them and excludes expired evidence from filters", async () => {
  await seed();
  let now = Date.now();
  const enrichment = new LastfmEnrichment(lastfm, openCache, () => now);
  fetch
    .mockResolvedValueOnce(tagged())
    .mockResolvedValueOnce(Response.json({ toptags: { tag: [] } }))
    .mockResolvedValueOnce(tagged("New Tag"));
  const input = {
    uri: likedSong(3).track.uri,
    include_artist_fallback: false,
    request_budget: 2,
  };
  await enrichment.getTrackTags(input);
  now += 24 * 60 * 60 * 1_000 - 1;
  expect((await enrichment.getTrackTags(input)).track.cache_hit).toBe(true);
  now++;
  const cache = await openCache();
  expect(
    cache.query({ tag: "Breakbeat", limit: 10, offset: 0 }, now).total,
  ).toBe(0);
  cache.close();
  expect((await enrichment.getTrackTags(input)).track.status).toBe("empty");
  now += 6 * 60 * 60 * 1_000 - 1;
  expect((await enrichment.getTrackTags(input)).track.cache_hit).toBe(true);
  now++;
  expect((await enrichment.getTrackTags(input)).track.status).toBe("tagged");
  expect(fetch).toHaveBeenCalledTimes(3);
});
