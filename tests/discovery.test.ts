import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastfmClient } from "../src/lastfm/client.js";
import { LastfmConfigError } from "../src/lastfm/config.js";
import { DiscoveryService } from "../src/lastfm/discovery.js";
import { LibraryCache } from "../src/library/cache.js";
import { createServer } from "../src/server.js";
import { CatalogService } from "../src/spotify/catalog.js";
import { SpotifyClient } from "../src/spotify/client.js";
import {
  catalogTrack,
  searchPage as searchResponse,
} from "./fixtures/catalog.js";
import { jazzArtist, likedSong } from "./fixtures/library.js";

type Result = Awaited<ReturnType<DiscoveryService["discover"]>>;
let directory: string;
let client: Client;
let server: McpServer;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let spotifyFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let getApiKey: ReturnType<typeof vi.fn<() => Promise<string>>>;
let lastfm: LastfmClient;
let spotify: SpotifyClient;
const openCache = () => LibraryCache.open(directory);
const identity = (index: number) => ({
  artist: jazzArtist.name,
  title: `Synthetic Song ${index}`,
});
const candidate = (index: number, match?: string) => ({
  artist: { name: jazzArtist.name },
  name: identity(index).title,
  url: `https://www.last.fm/music/Synthetic/_/Song${index}`,
  ...(match ? { match } : {}),
});
const chart = (...indexes: number[]) =>
  Response.json({
    tracks: { track: indexes.map((index) => candidate(index)) },
  });
const similar = (...indexes: number[]) =>
  Response.json({
    similartracks: { track: indexes.map((index) => candidate(index, "49.5")) },
  });
const catalog = (index: number) =>
  catalogTrack(index, {
    name: identity(index).title,
    artists: [jazzArtist.name],
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-discovery-"));
  fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockRejectedValue(new Error("Unexpected Last.fm request"));
  spotifyFetch = vi.fn<typeof globalThis.fetch>();
  spotifyFetch.mockRejectedValue(new Error("Unexpected Spotify request"));
  getApiKey = vi.fn<() => Promise<string>>().mockResolvedValue("a".repeat(32));
  lastfm = new LastfmClient({
    fetch,
    getApiKey,
    minIntervalMs: 0,
    maxRetries: 0,
  });
  spotify = new SpotifyClient({
    fetch: spotifyFetch,
    getAccessToken: async () => "synthetic-token",
  });
  server = createServer(spotify, openCache, lastfm);
  client = new Client({ name: "synthetic-discovery-tests", version: "0.1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const cache = await openCache();
  try {
    cache.saveArtist(jazzArtist);
    cache.saveTracks(
      [1, 2, 3].map((index) => {
        const song = likedSong(index);
        return {
          uri: song.track.uri,
          id: song.track.id,
          title: song.track.name,
          album: song.track.album.name,
          year: 2020,
          addedAt: song.added_at,
          artists: song.track.artists,
        };
      }),
      "synthetic-sync",
    );
    cache.finishSync(new Date().toISOString(), null, "synthetic-sync");
  } finally {
    cache.close();
  }
});

afterEach(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

async function tags(
  index: number,
  names: string[],
  level: "track" | "artist" = "track",
) {
  const cache = await openCache();
  try {
    const key = `synthetic-${level}-${index}`;
    cache.saveLastfmLookup({
      key,
      level,
      artist: jazzArtist.name,
      title: level === "track" ? identity(index).title : null,
      tags: names.map((name) => ({
        name,
        normalized: name.toLowerCase(),
        count: 80,
        url: `https://www.last.fm/tag/${name}`,
      })),
      sourceUrl: "https://www.last.fm/music/Synthetic",
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      notFound: false,
    });
    if (level === "track") cache.linkLastfmTrack(catalog(index).uri, key);
    else cache.linkLastfmArtist(jazzArtist.id, key);
  } finally {
    cache.close();
  }
}
async function discover(args: Record<string, unknown>) {
  const response = await client.callTool({
    name: "discover_tracks",
    arguments: args,
  });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as Result;
}

describe("Last.fm discovery", () => {
  it("Given fresh Spotify metadata identifies an existing library URI, when discovered after a catalog track, then reports library membership and sorts it first", async () => {
    fetch.mockResolvedValueOnce(chart(4, 5));
    spotifyFetch
      .mockResolvedValueOnce(searchResponse([catalog(4)]))
      .mockResolvedValueOnce(
        searchResponse([
          catalogTrack(1, {
            name: identity(5).title,
            artists: [jazzArtist.name],
          }),
        ]),
      );
    const result = await discover({ tags: ["jazz"], limit: 2 });
    expect(
      result.results.map((value) => [
        value.uri,
        value.source,
        value.verified_by,
      ]),
    ).toEqual([
      [catalog(1).uri, "library", "spotify_search"],
      [catalog(4).uri, "catalog", "spotify_search"],
    ]);
  });

  it("Given distinct candidates resolve to the same Spotify URI, when discovered, then returns that URI only once", async () => {
    fetch.mockResolvedValueOnce(chart(4, 5));
    spotifyFetch
      .mockResolvedValueOnce(searchResponse([catalog(4)]))
      .mockResolvedValueOnce(
        searchResponse([
          catalogTrack(4, {
            name: identity(5).title,
            artists: [jazzArtist.name],
          }),
        ]),
      );
    const result = await discover({ tags: ["jazz"], limit: 2 });
    expect(result.results.map((value) => value.uri)).toEqual([catalog(4).uri]);
    expect(result.catalog_candidates_verified).toBe(2);
    expect(result.results[0]?.evidence).toHaveLength(2);
  });

  it("Given enough tagged library matches, when discovering offline, then returns local evidence without any provider request", async () => {
    await tags(1, ["uptempo"]);
    getApiKey.mockRejectedValue(new LastfmConfigError());
    const result = await discover({ tags: ["uptempo"], limit: 1 });
    expect(result.results).toMatchObject([
      {
        uri: catalog(1).uri,
        source: "library",
        verified_by: "spotify_library_cache",
        evidence: [{ kind: "cached_tag", level: "track", tag: "uptempo" }],
      },
    ]);
    expect(result.lastfm_requests).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(spotifyFetch).not.toHaveBeenCalled();
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it("Given artist-only tags, when track evidence is required, then unknown track tags do not match", async () => {
    await tags(1, ["uptempo"], "artist");
    fetch.mockResolvedValueOnce(chart());
    const result = await discover({
      tags: ["uptempo"],
      tag_level: "track",
      limit: 1,
    });
    expect(result.results).toEqual([]);
    expect(result.lastfm_requests).toBe(1);
    expect(spotifyFetch).not.toHaveBeenCalled();
  });

  it("Given chart candidates in catalog-first order, when discovered, then cached library tracks precede verified catalog additions", async () => {
    fetch.mockResolvedValueOnce(chart(4, 1));
    spotifyFetch.mockResolvedValueOnce(searchResponse([catalog(4)]));
    const result = await discover({ tags: ["uptempo"], limit: 2 });
    expect(result.results.map((value) => [value.uri, value.source])).toEqual([
      [catalog(1).uri, "library"],
      [catalog(4).uri, "catalog"],
    ]);
    expect(result.results[1]).toMatchObject({
      verified_by: "spotify_search",
      confidence: 1,
      evidence: [{ kind: "lastfm_tag_listing", tag: "uptempo" }],
    });
    expect(result.library_matches).toBe(1);
    expect(result.catalog_matches).toBe(1);
    expect(spotifyFetch).toHaveBeenCalledTimes(1);
    expect(
      [...fetch.mock.calls, ...spotifyFetch.mock.calls].every(
        (call) => call[1]?.method === "GET",
      ),
    ).toBe(true);
  });

  it("Given a seed and raw similarity scores, when discovering, then preserves provenance without claiming measured audio features", async () => {
    fetch.mockResolvedValueOnce(similar(4, 2));
    spotifyFetch.mockResolvedValueOnce(searchResponse([catalog(4)]));
    const result = await discover({ seeds: [identity(9)], limit: 2 });
    expect(result.results.map((value) => value.uri)).toEqual([
      catalog(2).uri,
      catalog(4).uri,
    ]);
    expect(result.results[0]?.evidence).toMatchObject([
      { kind: "lastfm_similarity", seed: identity(9), similarity_score: 49.5 },
    ]);
    expect(result.note).toContain("not measured tempo");
    expect(JSON.stringify(result)).not.toContain('"bpm"');
    expect(
      new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("method"),
    ).toBe("track.getSimilar");
  });

  it("Given multiple requested tags, when a candidate appears in only one listing, then excludes it as insufficient evidence", async () => {
    fetch.mockResolvedValueOnce(chart(1, 4)).mockResolvedValueOnce(chart(4));
    spotifyFetch.mockResolvedValueOnce(searchResponse([catalog(4)]));
    const result = await discover({ tags: ["uptempo", "jazz"], limit: 2 });
    expect(result.results.map((value) => value.uri)).toEqual([catalog(4).uri]);
    expect(result.unresolved).toMatchObject([
      { input: identity(1), reason: "insufficient_tag_evidence" },
    ]);
    expect(result.results[0]?.evidence).toHaveLength(2);
    expect(spotifyFetch).toHaveBeenCalledTimes(1);
  });

  it("Given cached tag evidence, when matching all tags locally, then requires every tag and honors track level", async () => {
    await tags(1, ["uptempo", "jazz"]);
    await tags(2, ["jazz"]);
    const result = await discover({
      tags: ["uptempo", "jazz"],
      tag_level: "track",
      limit: 1,
    });
    expect(result.results.map((value) => value.uri)).toEqual([catalog(1).uri]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Given overlapping tag and seed sources, when merged, then verifies each candidate once and preserves both sources", async () => {
    fetch.mockResolvedValueOnce(chart(4, 4)).mockResolvedValueOnce(similar(4));
    spotifyFetch.mockResolvedValueOnce(searchResponse([catalog(4)]));
    const result = await discover({
      tags: ["jazz", " JAZZ "],
      seeds: [identity(9), identity(9)],
      limit: 2,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.evidence.map((value) => value.kind)).toEqual([
      "lastfm_tag_listing",
      "lastfm_similarity",
    ]);
    expect(result.lastfm_requests).toBe(2);
    expect(result.catalog_candidates_verified).toBe(1);
  });

  it.each([
    { name: identity(4).title, artists: ["Different Synthetic Artist"] },
    { name: "Different Synthetic Song", artists: [jazzArtist.name] },
    { name: `${identity(4).title} - Live`, artists: [jazzArtist.name] },
  ])(
    "Given a wrong artist, song or version %j, when verified, then returns unresolved without a Spotify URI",
    async (options) => {
      fetch.mockResolvedValueOnce(chart(4));
      spotifyFetch.mockImplementation(async () =>
        searchResponse([catalogTrack(4, options)]),
      );
      const result = await discover({ tags: ["jazz"], limit: 1 });
      expect(result.results).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
      expect(JSON.stringify(result.unresolved)).not.toContain("spotify:track:");
      expect(spotifyFetch).toHaveBeenCalledTimes(2);
    },
  );

  it("Given exhausted Last.fm budget, when more sources remain, then stops requests and reports incomplete evidence", async () => {
    fetch.mockImplementation(async () => chart(4));
    const result = await discover({
      tags: ["jazz", "uptempo", "funk"],
      request_budget: 2,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.lastfm_requests).toBe(2);
    expect(result.results).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/budget/i);
    expect(spotifyFetch).not.toHaveBeenCalled();
  });

  it("Given a catalog verification limit, when the first candidate fails, then stops at the limit without fabricating later matches", async () => {
    fetch.mockResolvedValueOnce(chart(4, 5));
    spotifyFetch.mockImplementation(async () => searchResponse([]));
    const result = await discover({ tags: ["jazz"], resolve_limit: 1 });
    expect(result.catalog_candidates_verified).toBe(1);
    expect(result.results).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/verification limit/);
    expect(spotifyFetch).toHaveBeenCalledTimes(2);
  });

  it("Given cached source candidates, when repeated in a new service call, then skips Last.fm HTTP but verifies Spotify identities again", async () => {
    fetch.mockResolvedValueOnce(chart(4));
    spotifyFetch.mockImplementation(async () => searchResponse([catalog(4)]));
    await discover({ tags: ["jazz"], limit: 1 });
    const result = await discover({ tags: ["JAZZ"], limit: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.lastfm_requests).toBe(0);
    expect(result.sources[0]?.cache_hit).toBe(true);
    expect(spotifyFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["no-store", "max-age=0"])(
    "Given provider %s caching policy, when repeated, then fetches source candidates again",
    async (control) => {
      fetch.mockImplementation(async () =>
        Response.json(
          { tracks: { track: [] } },
          { headers: { "Cache-Control": control } },
        ),
      );
      await discover({ tags: ["jazz"] });
      await discover({ tags: ["jazz"] });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("Given an empty source, when six hours elapse, then its negative cache expires", async () => {
    let now = Date.now();
    const discovery = new DiscoveryService(
      new CatalogService(spotify),
      lastfm,
      openCache,
      () => now,
    );
    fetch.mockImplementation(async () => chart());
    const input = {
      tags: ["jazz"],
      seeds: [],
      limit: 1,
      tag_level: "any" as const,
      request_budget: 1,
      resolve_limit: 1,
    };
    await discovery.discover(input);
    now += 6 * 60 * 60 * 1000 - 1;
    expect((await discovery.discover(input)).lastfm_requests).toBe(0);
    now += 2;
    expect((await discovery.discover(input)).lastfm_requests).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Given missing Last.fm credentials, when local matches are insufficient, then retains supported matches and reports configuration instructions", async () => {
    await tags(1, ["jazz"]);
    getApiKey.mockRejectedValue(new LastfmConfigError());
    const result = await discover({ tags: ["jazz"], limit: 2 });
    expect(result.results.map((value) => value.uri)).toEqual([catalog(1).uri]);
    expect(result.warnings.join(" ")).toContain("lastfm:configure");
    expect(fetch).not.toHaveBeenCalled();
    expect((await client.listTools()).tools.length).toBe(15);
  });

  it("Given a provider error containing credentials, when returned as a warning, then removes secrets and does not cache the error", async () => {
    fetch.mockImplementation(async () =>
      Response.json({ error: 10, message: `bad ${"a".repeat(32)}` }),
    );
    const first = await discover({ tags: ["jazz"] });
    await discover({ tags: ["jazz"] });
    expect(first.warnings.join(" ")).toContain("lastfm:configure");
    expect(JSON.stringify(first)).not.toContain("a".repeat(32));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    {},
    { tags: [] },
    { tags: ["jazz"], limit: 51 },
    { seeds: [{ title: "Missing artist" }] },
    { tags: ["jazz"], request_budget: 21 },
    { tags: ["jazz"], resolve_limit: 0 },
  ])(
    "Given invalid inputs %j, when called, then rejects before provider requests",
    async (arguments_) => {
      const result = await client.callTool({
        name: "discover_tracks",
        arguments: arguments_,
      });
      expect(result.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(spotifyFetch).not.toHaveBeenCalled();
    },
  );
});
