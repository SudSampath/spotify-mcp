import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginRequiredError } from "../src/auth/errors.js";
import { LibraryCache } from "../src/library/cache.js";
import { PlaylistService } from "../src/playlist/service.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { catalogTrack, searchPage } from "./fixtures/catalog.js";
import { jazzArtist, libraryPage, likedSong } from "./fixtures/library.js";

type Preview = Awaited<ReturnType<PlaylistService["preview"]>>;
let directory: string;
let client: Client;
let server: McpServer;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let spotify: SpotifyClient;
const accountId = "synthetic-playlist-owner";
const playlistId = "P".repeat(22);
const url = `https://open.spotify.com/playlist/${playlistId}`;
const uri = (index: number) => catalogTrack(index).uri;
const uriList = (count: number) =>
  Array.from({ length: count }, (_, index) => uri(index + 1));
const openCache = () => LibraryCache.open(directory);
const playlist = (options: Record<string, unknown> = {}) => ({
  id: playlistId,
  name: "Synthetic Playlist",
  owner: { id: accountId },
  collaborative: false,
  public: false,
  description: "Synthetic description",
  items: { total: 12 },
  ...options,
});

async function connect() {
  server = createServer(spotify, openCache);
  client = new Client({ name: "synthetic-playlist-tests", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
}

async function seed(count = 2) {
  const cache = await openCache();
  try {
    cache.saveArtist(jazzArtist);
    cache.saveTracks(
      Array.from({ length: count }, (_, index) => {
        const song = likedSong(index + 1);
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
      "synthetic-playlist-sync",
    );
    cache.finishSync(new Date().toISOString(), null, "synthetic-playlist-sync");
  } finally {
    cache.close();
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-playlists-"));
  fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockImplementation(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/me") return Response.json({ id: accountId });
    if (path === "/v1/me/playlists" && options?.method === "POST")
      return Response.json(playlist());
    if (path === "/v1/me/playlists")
      return Response.json({ items: [playlist()], total: 1, next: null });
    if (path === `/v1/playlists/${playlistId}`)
      return Response.json(playlist());
    if (path === `/v1/playlists/${playlistId}/items`)
      return Response.json({ snapshot_id: "synthetic-snapshot" });
    const track = path.match(/^\/v1\/tracks\/([A-Za-z0-9]{22})$/)?.[1];
    if (track) return Response.json(catalogTrack(Number.parseInt(track, 36)));
    throw new Error("Unexpected synthetic playlist endpoint");
  });
  spotify = new SpotifyClient({
    fetch,
    getAccessToken: async () => "synthetic-playlist-token",
    sleep: async () => {},
    maxRetries: 1,
  });
  await connect();
  await seed();
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
async function preview(
  uris = uriList(2),
  extra: Record<string, unknown> = {},
): Promise<Preview> {
  const { response, data } = await call("create_playlist", {
    name: "Synthetic Preview",
    uris,
    ...extra,
  });
  expect(response.isError).not.toBe(true);
  return data as Preview;
}
const writes = () =>
  fetch.mock.calls.filter((call) => call[1]?.method !== "GET");
const creates = () =>
  writes().filter(
    (call) => new URL(String(call[0])).pathname === "/v1/me/playlists",
  );
const additions = () =>
  writes().filter((call) =>
    new URL(String(call[0])).pathname.endsWith("/items"),
  );
const body = (call: (typeof fetch.mock.calls)[number] | undefined) =>
  JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;

describe("Playlist previews", () => {
  it("Given library and catalog URIs with duplicates and invalid values, when previewed, then preserves order, labels membership and makes no writes", async () => {
    const data = await preview([
      uri(1),
      uri(3),
      uri(1),
      "invalid",
      `spotify:album:${"A".repeat(22)}`,
      ` ${uri(2)} `,
    ]);
    expect(data).toMatchObject({
      status: "preview",
      action: "create",
      name: "Synthetic Preview",
      public: false,
      track_count: 3,
      requires_confirmation: true,
      tracks: [
        { uri: uri(1), source: "library", name: "Synthetic Song 1" },
        { uri: uri(3), source: "catalog" },
        { uri: uri(2), source: "library" },
      ],
      duplicates: [{ index: 2, uri: uri(1), first_index: 0 }],
      invalid: [
        { index: 3, reason: "invalid_track_uri" },
        { index: 4, reason: "invalid_track_uri" },
      ],
    });
    expect(data.preview_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(Date.parse(data.expires_at) - Date.parse(data.created_at)).toBe(
      30 * 60_000,
    );
    expect(data).not.toHaveProperty("account_id");
    expect(writes()).toEqual([]);
    expect(
      fetch.mock.calls.filter((call) => String(call[0]).includes("/tracks/")),
    ).toHaveLength(1);
  });

  it.each([
    {
      status: 404,
      value: { error: { message: "Synthetic not found" } },
      reason: "track_not_found",
    },
    {
      status: 200,
      value: catalogTrack(3, { playable: false }),
      reason: "unavailable_or_unverified_track",
    },
    {
      status: 200,
      value: catalogTrack(4),
      reason: "unavailable_or_unverified_track",
    },
    { status: 200, value: {}, reason: "unavailable_or_unverified_track" },
  ])(
    "Given missing or unverified catalog metadata %j, when previewed, then flags and excludes it from commit",
    async ({ status, value, reason }) => {
      fetch
        .mockResolvedValueOnce(Response.json({ id: accountId }))
        .mockResolvedValueOnce(Response.json(value, { status }));
      const data = await preview([uri(1), uri(3)]);
      expect(data.tracks.map((track) => track.uri)).toEqual([uri(1)]);
      expect(data.invalid).toMatchObject([{ uri: uri(3), reason }]);
      await call("commit_playlist", { preview_id: data.preview_id });
      expect(body(additions()[0]).uris).toEqual([uri(1)]);
    },
  );

  it("Given an unsynced library, when previewing, then reports incomplete membership and verifies catalog identities", async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
    await connect();
    const data = await preview([uri(1)]);
    expect(data.tracks[0]?.source).toBe("catalog");
    expect(data.warnings).toHaveLength(1);
    expect(data.library_synced_at).toBeNull();
  });

  it("Given only invalid URIs, when committing the preview, then refuses to create an empty playlist", async () => {
    const data = await preview(["bad"]);
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("empty_preview");
    expect(writes()).toEqual([]);
  });

  it.each([
    ["create_playlist", { name: "", uris: [uri(1)] }],
    ["create_playlist", { name: "Synthetic", uris: [] }],
    ["create_playlist", { name: "Synthetic", uris: uriList(501) }],
    ["add_to_playlist", { playlist_id: "bad", uris: [uri(1)] }],
    ["commit_playlist", { preview_id: "bad" }],
    ["list_playlists", { limit: 51 }],
  ])(
    "Given invalid %s arguments, when called, then rejects before account access",
    async (name, args) => {
      const result = await call(String(name), args as Record<string, unknown>);
      expect(result.response.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("Playlist commits", () => {
  it("Given an approved preview, when committed and repeated across a server restart, then creates exactly once and returns the existing URL", async () => {
    const data = await preview([uri(2), uri(1), uri(2)], {
      description: "Synthetic description",
    });
    const result = await call("commit_playlist", {
      preview_id: data.preview_id,
    });
    expect(result.data).toMatchObject({
      status: "committed",
      playlist_url: url,
      added_count: 2,
      added_uris: [uri(2), uri(1)],
      failed_uris: [],
      uncertain_uris: [],
      not_attempted_uris: [],
    });
    expect(body(creates()[0])).toEqual({
      name: "Synthetic Preview",
      description: "Synthetic description",
      public: false,
    });
    expect(body(additions()[0])).toEqual({ uris: [uri(2), uri(1)] });
    await client.close();
    await server.close();
    await connect();
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data,
    ).toMatchObject({
      status: "already_committed",
      playlist_url: url,
      added_count: 2,
      replay: true,
    });
    expect(creates()).toHaveLength(1);
    expect(additions()).toHaveLength(1);
  });

  it("Given a public preview, when committed, then preserves the explicitly previewed visibility", async () => {
    const data = await preview([uri(1)], { public: true });
    await call("commit_playlist", { preview_id: data.preview_id });
    expect(body(creates()[0]).public).toBe(true);
  });

  it("Given 150 approved tracks, when committed, then adds batches of 100 and 50 in exact input order", async () => {
    await seed(150);
    const uris = uriList(150).reverse();
    const data = await preview(uris);
    const result = await call("commit_playlist", {
      preview_id: data.preview_id,
    });
    expect(result.data).toMatchObject({
      status: "committed",
      added_count: 150,
    });
    expect(additions().map((call) => body(call).uris)).toEqual([
      uris.slice(0, 100),
      uris.slice(100),
    ]);
    expect(creates()).toHaveLength(1);
  });

  it("Given the second of three batches is rejected, when committed, then reports confirmed, failed and unattempted URIs without retrying", async () => {
    await seed(250);
    const data = await preview(uriList(250));
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(Response.json(playlist()))
      .mockResolvedValueOnce(Response.json({ snapshot_id: "first-batch" }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Synthetic forbidden" } },
          { status: 403 },
        ),
      );
    const result = await call("commit_playlist", {
      preview_id: data.preview_id,
    });
    expect(result.data).toMatchObject({
      status: "partial_failure",
      playlist_url: url,
      added_count: 100,
      added_uris: uriList(100),
      failed_uris: uriList(200).slice(100),
      uncertain_uris: [],
      not_attempted_uris: uriList(250).slice(200),
    });
    await call("commit_playlist", { preview_id: data.preview_id });
    expect(creates()).toHaveLength(1);
    expect(additions()).toHaveLength(2);
  });

  it.each(["network", "http500", "malformed-success"])(
    "Given an ambiguous create %s failure, when repeated, then never creates a second playlist",
    async (kind) => {
      const data = await preview([uri(1)]);
      fetch.mockResolvedValueOnce(Response.json({ id: accountId }));
      if (kind === "network")
        fetch.mockRejectedValueOnce(
          new Error("Synthetic network error with secret-token"),
        );
      else if (kind === "http500")
        fetch.mockResolvedValueOnce(
          Response.json(
            { error: { message: "Synthetic uncertain" } },
            { status: 500 },
          ),
        );
      else
        fetch.mockResolvedValueOnce(
          new Response("invalid JSON", { status: 201 }),
        );
      const result = await call("commit_playlist", {
        preview_id: data.preview_id,
      });
      expect(result.data).toMatchObject({
        status: "uncertain",
        playlist_url: null,
        added_count: 0,
        not_attempted_uris: [uri(1)],
      });
      expect(JSON.stringify(result)).not.toContain("secret-token");
      await call("commit_playlist", { preview_id: data.preview_id });
      expect(creates()).toHaveLength(1);
      expect(additions()).toHaveLength(0);
    },
  );

  it("Given an ambiguous second add batch, when it fails, then reports uncertain URIs separately from confirmed additions", async () => {
    await seed(150);
    const data = await preview(uriList(150));
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(Response.json(playlist()))
      .mockResolvedValueOnce(Response.json({ snapshot_id: "first-batch" }))
      .mockRejectedValueOnce(new Error("Synthetic connection lost"));
    const result = await call("commit_playlist", {
      preview_id: data.preview_id,
    });
    expect(result.data).toMatchObject({
      status: "uncertain",
      playlist_url: url,
      added_count: 100,
      failed_uris: [],
      uncertain_uris: uriList(150).slice(100),
      not_attempted_uris: [],
    });
    await call("commit_playlist", { preview_id: data.preview_id });
    expect(creates()).toHaveLength(1);
    expect(additions()).toHaveLength(2);
  });

  it("Given a rejected create, when repeated, then preserves the failure and performs no further writes", async () => {
    const data = await preview([uri(1)]);
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Synthetic forbidden" } },
          { status: 403 },
        ),
      );
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("failed");
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data,
    ).toMatchObject({ status: "failed", replay: true });
    expect(creates()).toHaveLength(1);
  });

  it("Given a different authenticated account, when committing, then refuses without consuming the original preview", async () => {
    const data = await preview([uri(1)]);
    fetch.mockResolvedValueOnce(
      Response.json({ id: "different-synthetic-user" }),
    );
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("account_mismatch");
    expect(writes()).toHaveLength(0);
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("committed");
  });

  it("Given an expired preview or unknown token, when committed, then refuses before account or write requests", async () => {
    let now = Date.now();
    const service = new PlaylistService(spotify, openCache, () => now);
    const data = await service.preview({ name: "Synthetic", uris: [uri(1)] });
    now += 30 * 60_000;
    fetch.mockClear();
    expect((await service.commit(data.preview_id)).status).toBe("expired");
    expect((await service.commit(randomUUID())).status).toBe("unknown_preview");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Given concurrent commits from separate services, when one is writing, then atomic claiming prevents a second create", async () => {
    const data = await preview([uri(1)]);
    let release: (value: Response) => void = () => {};
    let entered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockImplementationOnce(async () => {
        entered();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
    const first = new PlaylistService(spotify, openCache).commit(
      data.preview_id,
    );
    await waiting;
    const second = await new PlaylistService(spotify, openCache).commit(
      data.preview_id,
    );
    expect(second.status).toBe("in_progress");
    release(Response.json(playlist()));
    expect((await first).status).toBe("committed");
    expect(creates()).toHaveLength(1);
  });

  it("Given a process stopped after claiming, when committing again, then reports uncertainty without repeating writes", async () => {
    const data = await preview([uri(1)]);
    const cache = await openCache();
    try {
      const store = cache.playlistPreviews();
      expect(
        store.claim(data.preview_id, Date.now(), {
          status: "in_progress",
          preview_id: data.preview_id,
          playlist_id: playlistId,
          playlist_url: url,
          added_count: 0,
          added_uris: [],
          failed_uris: [],
          uncertain_uris: [],
          not_attempted_uris: [uri(1)],
          message: "Synthetic interrupted commit",
        }),
      ).toBe(true);
    } finally {
      cache.close();
    }
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Synthetic stopped process"), {
        code: "ESRCH",
      });
    });
    try {
      expect(
        (await call("commit_playlist", { preview_id: data.preview_id })).data,
      ).toMatchObject({
        status: "uncertain",
        playlist_url: url,
        uncertain_uris: [uri(1)],
      });
    } finally {
      kill.mockRestore();
    }
    expect(writes()).toHaveLength(0);
  });

  it("Given a rate-limited write, when committed, then retries only the rejected request and keeps a single playlist", async () => {
    const data = await preview([uri(1)]);
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Synthetic rate limit" } },
          { status: 429, headers: { "Retry-After": "0" } },
        ),
      )
      .mockResolvedValueOnce(Response.json(playlist()));
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("committed");
    expect(creates()).toHaveLength(2);
    expect(additions()).toHaveLength(1);
  });

  it("Given cancellation after the first batch, when committed, then sends no second batch and retains known progress", async () => {
    await seed(150);
    const service = new PlaylistService(spotify, openCache);
    const data = await service.preview({
      name: "Synthetic",
      uris: uriList(150),
    });
    const controller = new AbortController();
    const result = await service.commit(data.preview_id, {
      signal: controller.signal,
      onProgress: async () => controller.abort(),
    });
    expect(result).toMatchObject({
      status: "partial_failure",
      added_count: 100,
      failed_uris: [],
      uncertain_uris: [],
      not_attempted_uris: uriList(150).slice(100),
    });
    expect(additions()).toHaveLength(1);
  });
});

describe("Playlist listing and additions", () => {
  it("Given owned and followed playlists, when listed, then returns compact ownership, counts and pagination without writes", async () => {
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            playlist(),
            playlist({
              id: "Q".repeat(22),
              owner: { id: "other" },
              items: undefined,
              tracks: { total: 7 },
            }),
            null,
          ],
          total: 10,
          next: "https://api.spotify.com/v1/me/playlists?offset=3&limit=3",
        }),
      );
    expect((await call("list_playlists", { limit: 3 })).data).toMatchObject({
      playlists: [
        { id: playlistId, track_count: 12, owned: true },
        { id: "Q".repeat(22), track_count: 7, owned: false },
      ],
      next_offset: 3,
      skipped: 1,
    });
    expect(writes()).toEqual([]);
  });

  it("Given an owned playlist, when additions are previewed and committed, then appends once without creating a playlist", async () => {
    const data = (
      await call("add_to_playlist", {
        playlist_id: playlistId,
        uris: [uri(2), uri(1), uri(2)],
      })
    ).data as Preview;
    expect(data).toMatchObject({
      action: "add",
      name: "Synthetic Playlist",
      playlist_url: url,
      track_count: 2,
    });
    expect(writes()).toHaveLength(0);
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("committed");
    await call("commit_playlist", { preview_id: data.preview_id });
    expect(creates()).toHaveLength(0);
    expect(additions()).toHaveLength(1);
    expect(body(additions()[0]).uris).toEqual([uri(2), uri(1)]);
  });

  it("Given a followed playlist without collaboration, when additions are requested, then refuses before writing", async () => {
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(
        Response.json(playlist({ owner: { id: "other" } })),
      );
    const result = await call("add_to_playlist", {
      playlist_id: playlistId,
      uris: [uri(1)],
    });
    expect(result.response.isError).toBe(true);
    expect(JSON.stringify(result.response)).toContain("cannot be edited");
    expect(writes()).toHaveLength(0);
  });

  it("Given a collaborative playlist in current user's library, when previewed and committed, then permits append after rechecking access", async () => {
    const collaborator = playlist({
      owner: { id: "other" },
      collaborative: true,
    });
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(Response.json(collaborator))
      .mockResolvedValueOnce(
        Response.json({ items: [{ id: playlistId }], next: null }),
      );
    const data = (
      await call("add_to_playlist", { playlist_id: playlistId, uris: [uri(1)] })
    ).data as Preview;
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(Response.json(collaborator))
      .mockResolvedValueOnce(
        Response.json({ items: [{ id: playlistId }], next: null }),
      );
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("committed");
    expect(creates()).toHaveLength(0);
    expect(additions()).toHaveLength(1);
  });

  it("Given a collaborative flag but no current-user playlist membership, when additions are previewed, then refuses unverified access", async () => {
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(
        Response.json(
          playlist({ owner: { id: "other" }, collaborative: true }),
        ),
      )
      .mockResolvedValueOnce(Response.json({ items: [], next: null }));
    expect(
      (
        await call("add_to_playlist", {
          playlist_id: playlistId,
          uris: [uri(1)],
        })
      ).response.isError,
    ).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("Given edit access is removed after preview, when committed, then rechecks and refuses with no writes", async () => {
    const data = (
      await call("add_to_playlist", { playlist_id: playlistId, uris: [uri(1)] })
    ).data as Preview;
    fetch
      .mockResolvedValueOnce(Response.json({ id: accountId }))
      .mockResolvedValueOnce(
        Response.json(playlist({ owner: { id: "other" } })),
      );
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).response
        .isError,
    ).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("Given login is missing, when listing, then returns login instructions and keeps the server available", async () => {
    fetch.mockRejectedValueOnce(new LoginRequiredError());
    const result = await call("list_playlists");
    expect(result.response.isError).toBe(true);
    expect(JSON.stringify(result.response)).toContain("pnpm auth");
    await expect(client.ping()).resolves.toEqual({});
  });

  it("Given synthetic sync, resolution and preview, when explicitly committed, then receives exactly one create and the approved ordered add", async () => {
    await rm(directory, { recursive: true, force: true });
    fetch
      .mockResolvedValueOnce(libraryPage([likedSong(1)]))
      .mockResolvedValueOnce(Response.json(jazzArtist));
    expect(
      (await call("sync_library", { full: true })).response.isError,
    ).not.toBe(true);
    fetch.mockResolvedValueOnce(searchPage([catalogTrack(9)]));
    const resolved = await call("resolve_tracks", {
      tracks: [{ artist: "Synthetic Artist", title: "Synthetic Song" }],
    });
    expect(resolved.data).toMatchObject({ matched: [{ uri: uri(9) }] });
    const data = await preview([uri(1), uri(9)]);
    expect(data.tracks.map((track) => track.source)).toEqual([
      "library",
      "catalog",
    ]);
    expect(writes()).toHaveLength(0);
    expect(
      (await call("commit_playlist", { preview_id: data.preview_id })).data
        ?.status,
    ).toBe("committed");
    expect(creates()).toHaveLength(1);
    expect(additions()).toHaveLength(1);
    expect(body(additions()[0]).uris).toEqual([uri(1), uri(9)]);
  });
});
