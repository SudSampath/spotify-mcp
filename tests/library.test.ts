import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_REQUIRED_MESSAGE,
  LoginRequiredError,
} from "../src/auth/errors.js";
import { LibraryCache } from "../src/library/cache.js";
import { LibraryService } from "../src/library/sync.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import {
  jazzArtist,
  libraryPage,
  likedSong,
  rockArtist,
  type SyntheticLikedSong,
  unknownArtist,
} from "./fixtures/library.js";

let directory: string;
let client: Client;
let server: McpServer;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
let getAccessToken: ReturnType<typeof vi.fn<() => Promise<string>>>;
let spotify: SpotifyClient;
const openCache = () => LibraryCache.open(directory);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-library-"));
  fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockRejectedValue(new Error("Unexpected mocked library request"));
  sleep = vi.fn<(ms: number) => Promise<void>>();
  sleep.mockResolvedValue(undefined);
  getAccessToken = vi.fn<() => Promise<string>>();
  getAccessToken.mockResolvedValue("synthetic-access");
  spotify = new SpotifyClient({ fetch, getAccessToken, sleep });
  server = createServer(spotify, openCache);
  client = new Client({ name: "synthetic-library-tests", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
});
afterEach(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  return {
    response,
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}
function text(response: Awaited<ReturnType<typeof client.callTool>>): string {
  const content = response.content as { type: string; text?: string }[];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
function useLibrary(
  songs: SyntheticLikedSong[],
  artists = [jazzArtist, rockArtist, unknownArtist],
) {
  fetch.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me/tracks") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const next =
        offset + 50 < songs.length
          ? `https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset + 50}`
          : null;
      return libraryPage(songs.slice(offset, offset + 50), next);
    }
    const artist = artists.find(
      (value) => url.pathname === `/v1/artists/${value.id}`,
    );
    if (artist) return Response.json(artist);
    throw new Error("Unexpected mocked library endpoint");
  });
}
function artistCalls() {
  return fetch.mock.calls.filter(([url]) => String(url).includes("/artists/"));
}

describe("Library sync", () => {
  it("Given an empty cache and multiple pages, when synced, then stores complete track metadata and each artist only once", async () => {
    const first = likedSong(3, {
      year: 1998,
      artists: [jazzArtist, rockArtist],
    });
    fetch
      .mockResolvedValueOnce(
        libraryPage(
          [first, likedSong(2)],
          "https://api.spotify.com/v1/me/tracks?offset=2&limit=50",
        ),
      )
      .mockResolvedValueOnce(Response.json(jazzArtist))
      .mockResolvedValueOnce(Response.json(rockArtist))
      .mockResolvedValueOnce(libraryPage([likedSong(1)]));
    const { response, data } = await call("sync_library");
    expect(response.isError).not.toBe(true);
    expect(data).toMatchObject({
      full: true,
      tracks_synced: 3,
      tracks_added: 3,
      artists_cached: 2,
      total_tracks: 3,
    });
    expect(artistCalls()).toHaveLength(2);
    const cache = await openCache();
    try {
      const saved = cache.query({ limit: 10, offset: 0 }).tracks[0];
      expect(saved).toMatchObject({
        uri: first.track.uri,
        title: first.track.name,
        album: first.track.album.name,
        year: 1998,
        addedAt: first.added_at,
        genres: ["jazz-funk", "jazz", "alternative rock"],
      });
      expect(saved?.artists.map((artist) => artist.name)).toEqual([
        jazzArtist.name,
        rockArtist.name,
      ]);
      expect((await stat(cache.path)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      cache.close();
    }
  });

  it("Given a prior sync and three new songs, when syncing incrementally, then stores only new rows and stops before older pages", async () => {
    useLibrary([likedSong(3), likedSong(2), likedSong(1)]);
    await call("sync_library");
    fetch.mockClear();
    fetch.mockResolvedValueOnce(
      libraryPage(
        [likedSong(6), likedSong(5), likedSong(4), likedSong(3), likedSong(2)],
        "https://api.spotify.com/v1/me/tracks?offset=50",
      ),
    );
    const { data } = await call("sync_library");
    expect(data).toMatchObject({
      full: false,
      tracks_synced: 3,
      tracks_added: 3,
      artists_cached: 0,
      total_tracks: 6,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await call("get_library")).data).toMatchObject({ total: 6 });
  });

  it("Given a new URI at the checkpoint timestamp on the next page, when syncing, then does not miss it", async () => {
    useLibrary([likedSong(3), likedSong(2)]);
    await call("sync_library");
    fetch.mockClear();
    const sameTime = likedSong(99, { addedAt: likedSong(3).added_at });
    fetch
      .mockResolvedValueOnce(
        libraryPage(
          [likedSong(3)],
          "https://api.spotify.com/v1/me/tracks?offset=1",
        ),
      )
      .mockResolvedValueOnce(libraryPage([sameTime, likedSong(2)]));
    expect((await call("sync_library")).data).toMatchObject({
      tracks_added: 1,
      total_tracks: 3,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(text((await call("get_library")).response)).toContain(
      sameTime.track.uri,
    );
  });

  it("Given an unliked song, when a full sync completes, then removes it from the cache and reuses artist genres", async () => {
    useLibrary([likedSong(3), likedSong(2), likedSong(1)]);
    await call("sync_library");
    fetch.mockClear();
    useLibrary([likedSong(3), likedSong(2)]);
    expect((await call("sync_library", { full: true })).data).toMatchObject({
      full: true,
      tracks_removed: 1,
      total_tracks: 2,
      artists_cached: 0,
    });
    expect(artistCalls()).toHaveLength(0);
    expect(text((await call("get_library")).response)).not.toContain(
      likedSong(1).track.uri,
    );
  });

  it("Given a failed full sync after one page, when retrying, then preserves old rows and the prior checkpoint until success", async () => {
    useLibrary([likedSong(3), likedSong(2), likedSong(1)]);
    await call("sync_library");
    const before = await openCache();
    const state = before.state();
    before.close();
    fetch.mockClear();
    fetch
      .mockResolvedValueOnce(
        libraryPage(
          [likedSong(4)],
          "https://api.spotify.com/v1/me/tracks?offset=1",
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Synthetic temporary failure" } },
          { status: 500 },
        ),
      );
    expect((await call("sync_library", { full: true })).response.isError).toBe(
      true,
    );
    const partial = await openCache();
    expect(partial.state()).toEqual(state);
    expect(partial.count()).toBe(4);
    partial.close();
    useLibrary([likedSong(4), likedSong(3)]);
    expect((await call("sync_library", { full: true })).data).toMatchObject({
      tracks_removed: 2,
      total_tracks: 2,
      tracks_added: 0,
    });
    expect((await call("get_library")).data).toMatchObject({ total: 2 });
  });

  it("Given an interrupted first sync, when retried, then reuses artist metadata, prunes stale partial rows and creates no duplicates", async () => {
    fetch
      .mockResolvedValueOnce(
        libraryPage(
          [likedSong(2), likedSong(1)],
          "https://api.spotify.com/v1/me/tracks?offset=2",
        ),
      )
      .mockResolvedValueOnce(Response.json(jazzArtist))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Synthetic interruption" } },
          { status: 500 },
        ),
      );
    expect((await call("sync_library")).response.isError).toBe(true);
    expect(text((await call("get_library")).response)).toContain(
      "Run sync_library first",
    );
    fetch.mockClear();
    useLibrary([likedSong(2)]);
    expect((await call("sync_library")).data).toMatchObject({
      full: true,
      total_tracks: 1,
      tracks_added: 0,
      tracks_removed: 1,
      artists_cached: 0,
    });
    expect(artistCalls()).toHaveLength(0);
  });

  it("Given a 429 on a later page, when syncing, then honors Retry-After and continues without duplicates", async () => {
    fetch
      .mockResolvedValueOnce(
        libraryPage(
          [likedSong(2)],
          "https://api.spotify.com/v1/me/tracks?offset=1",
        ),
      )
      .mockResolvedValueOnce(Response.json(jazzArtist))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Synthetic rate limit" } },
          { status: 429, headers: { "Retry-After": "2" } },
        ),
      )
      .mockResolvedValueOnce(libraryPage([likedSong(1)]));
    expect((await call("sync_library")).data).toMatchObject({
      total_tracks: 2,
      tracks_added: 2,
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect((await call("get_library")).data).toMatchObject({ total: 2 });
  });

  it("Given an empty library, when synced, then records a completed empty snapshot", async () => {
    useLibrary([]);
    expect((await call("sync_library")).data).toMatchObject({
      total_tracks: 0,
      tracks_added: 0,
    });
    expect((await call("get_library")).data).toMatchObject({
      total: 0,
      returned: 0,
    });
  });

  it("Given empty artist genres, when syncing again, then does not fetch them repeatedly", async () => {
    useLibrary([likedSong(1, { artists: [unknownArtist] })]);
    await call("sync_library");
    fetch.mockClear();
    useLibrary([
      likedSong(2, { artists: [unknownArtist] }),
      likedSong(1, { artists: [unknownArtist] }),
    ]);
    expect((await call("sync_library")).data).toMatchObject({
      tracks_added: 1,
      artists_cached: 0,
    });
    expect(artistCalls()).toHaveLength(0);
  });

  it("Given unavailable or local tracks, when synced, then skips them without inventing Spotify URIs", async () => {
    fetch
      .mockResolvedValueOnce(
        libraryPage([
          { added_at: likedSong(3).added_at, track: null },
          { added_at: likedSong(2).added_at, track: { is_local: true } },
          likedSong(1),
        ]),
      )
      .mockResolvedValueOnce(Response.json(jazzArtist));
    expect((await call("sync_library")).data).toMatchObject({
      skipped_tracks: 2,
      total_tracks: 1,
    });
  });
});

describe("Genre availability", () => {
  it("Given three artist responses without genres, when syncing, then caches remaining identities without more genre requests and reports coverage", async () => {
    const identities = Array.from({ length: 5 }, (_, i) => ({
      id: String.fromCharCode(68 + i).repeat(22),
      name: `Synthetic Missing Genre Artist ${i}`,
    }));
    const songs = identities
      .slice(0, 4)
      .map((artist, i) => likedSong(4 - i, { artists: [artist] }));
    fetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/me/tracks") return libraryPage(songs);
      const artist = identities.find((value) =>
        url.pathname.endsWith(value.id),
      );
      if (artist) return Response.json(artist);
      throw new Error("Unexpected synthetic genre endpoint");
    });
    const synced = await call("sync_library");
    expect(synced.data).toMatchObject({
      total_tracks: 4,
      artists_cached: 4,
      artist_requests: 3,
      genre_coverage: {
        total_tracks: 4,
        tracks_with_genres: 0,
        spotify_genres_omitted: true,
      },
    });
    expect(String(synced.data?.warning)).toContain("incomplete coverage");
    expect(artistCalls()).toHaveLength(3);
    fetch.mockClear();
    const fifth = identities[4];
    if (!fifth) throw new Error("Missing synthetic fixture");
    songs.unshift(likedSong(5, { artists: [fifth] }));
    expect((await call("sync_library")).data).toMatchObject({
      artists_cached: 1,
      artist_requests: 0,
      total_tracks: 5,
    });
    expect(artistCalls()).toHaveLength(0);
    const filtered = await call("get_library", { genre: "jazz" });
    expect(filtered.data).toMatchObject({
      total: 0,
      genre_coverage: {
        total_tracks: 5,
        tracks_with_genres: 0,
        spotify_genres_omitted: true,
      },
    });
    expect(text(filtered.response)).toContain("incomplete coverage");
  });

  it("Given an explicit empty genres array, when other artists are fetched, then keeps attempting genre enrichment", async () => {
    const identities = Array.from({ length: 5 }, (_, i) => ({
      id: String.fromCharCode(68 + i).repeat(22),
      name: `Synthetic Mixed Genre Artist ${i}`,
    }));
    const songs = identities.map((artist, i) =>
      likedSong(5 - i, { artists: [artist] }),
    );
    fetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/me/tracks") return libraryPage(songs);
      const index = identities.findIndex((value) =>
        url.pathname.endsWith(value.id),
      );
      const artist = identities[index];
      if (!artist) throw new Error("Unexpected synthetic artist");
      return Response.json(index === 2 ? { ...artist, genres: [] } : artist);
    });
    expect((await call("sync_library")).data).toMatchObject({
      artist_requests: 5,
      genre_coverage: { spotify_genres_omitted: false },
    });
    expect(artistCalls()).toHaveLength(5);
  });
});

it("Given a progress token, when a library sync runs, then sends increasing progress notifications", async () => {
  useLibrary([likedSong(1)]);
  const updates: { progress: number }[] = [];
  client.setNotificationHandler(
    "notifications/progress",
    async (notification) => {
      updates.push({ progress: notification.params.progress });
    },
  );
  const response = await client.callTool({
    name: "sync_library",
    arguments: {},
    _meta: { progressToken: "synthetic-library-progress" },
  });
  expect(response.isError).not.toBe(true);
  expect(updates.length).toBeGreaterThanOrEqual(2);
  expect(
    updates.every(
      (value, index) =>
        index === 0 || value.progress > (updates[index - 1]?.progress ?? -1),
    ),
  ).toBe(true);
});

describe("Library queries", () => {
  it("Given no completed sync, when querying, then instructs the agent to sync first without HTTP", async () => {
    expect(text((await call("get_library")).response)).toContain(
      "Run sync_library first",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Given mixed artist genres, when filtering jazz, then returns only matching tracks with their URIs and a total", async () => {
    useLibrary([
      likedSong(3),
      likedSong(2, { artists: [rockArtist] }),
      likedSong(1, { artists: [unknownArtist] }),
    ]);
    await call("sync_library");
    fetch.mockClear();
    const { data, response } = await call("get_library", { genre: "JAZZ" });
    expect(data).toMatchObject({ total: 1, returned: 1 });
    expect(text(response)).toContain(likedSong(3).track.uri);
    expect(text(response)).not.toContain(likedSong(2).track.uri);
    expect(text(response)).not.toContain(likedSong(1).track.uri);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Given combined artist/year/date filters, when querying, then combines them with AND and honors exclusive added_after", async () => {
    useLibrary([
      likedSong(4, { year: 1998 }),
      likedSong(3, { year: 2020 }),
      likedSong(2, { year: 1998 }),
      likedSong(1, { year: 1998, artists: [rockArtist] }),
    ]);
    await call("sync_library");
    fetch.mockClear();
    const { data, response } = await call("get_library", {
      artist: "jAzZ",
      year: 1998,
      added_after: "2026-01-01T01:00:02+01:00",
    });
    expect(data).toMatchObject({ total: 1 });
    expect(text(response)).toContain(likedSong(4).track.uri);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Given literal wildcard or SQL-like text, when filtering, then does not broaden the results or change the database", async () => {
    useLibrary([likedSong(1)]);
    await call("sync_library");
    expect((await call("get_library", { genre: "%" })).data).toMatchObject({
      total: 0,
    });
    expect(
      (await call("get_library", { artist: "' OR 1=1 --" })).data,
    ).toMatchObject({ total: 0 });
    expect((await call("get_library")).data).toMatchObject({ total: 1 });
  });
  it("Given 2000 cached tracks, when paging, then returns bounded compact lines with stable ordering and a total", async () => {
    useLibrary(Array.from({ length: 2_000 }, (_, i) => likedSong(2_000 - i)));
    expect((await call("sync_library")).data).toMatchObject({
      total_tracks: 2_000,
      artists_cached: 1,
    });
    fetch.mockClear();
    const { data, response } = await call("get_library", {
      limit: 2,
      offset: 50,
    });
    expect(data).toMatchObject({
      total: 2_000,
      limit: 2,
      offset: 50,
      returned: 2,
    });
    const lines = text(response).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(likedSong(1_950).track.uri);
    expect(lines[2]).toContain(likedSong(1_949).track.uri);
    expect(lines.slice(1).every((line) => line.length < 170)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { year: 1.2 },
    { added_after: "not-a-date" },
    { genre: " " },
  ])(
    "Given invalid filters %j, when querying, then rejects them without HTTP",
    async (args) => {
      expect((await call("get_library", args)).response.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

it("Given missing login, when syncing, then returns auth instructions and leaves MCP running", async () => {
  getAccessToken.mockRejectedValue(new LoginRequiredError());
  expect((await call("sync_library")).response).toMatchObject({
    isError: true,
    content: [{ type: "text", text: LOGIN_REQUIRED_MESSAGE }],
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(client.ping()).resolves.toEqual({});
});

it("Given a sync already in progress, when a second sync starts, then rejects it while allowing cache reads", async () => {
  const first = await openCache();
  first.acquireSync("synthetic-other-sync");
  try {
    const { response } = await call("sync_library");
    expect(response.isError).toBe(true);
    expect(text(response)).toContain("already running");
    expect(fetch).not.toHaveBeenCalled();
    expect(text((await call("get_library")).response)).toContain(
      "sync_library first",
    );
  } finally {
    first.releaseSync("synthetic-other-sync");
    first.close();
  }
});

it("Given cancellation before a sync, when attempted, then sends no HTTP and releases the sync lock", async () => {
  const controller = new AbortController();
  controller.abort();
  const service = new LibraryService(spotify, openCache);
  await expect(service.sync({ signal: controller.signal })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  useLibrary([]);
  await expect(service.sync()).resolves.toMatchObject({ total_tracks: 0 });
});
