import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginRequiredError } from "../src/auth/errors.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { catalogTrack, searchPage } from "./fixtures/catalog.js";

let client: Client;
let server: McpServer;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
let getAccessToken: ReturnType<typeof vi.fn<() => Promise<string>>>;

beforeEach(async () => {
  fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockRejectedValue(new Error("Unexpected mocked catalog request"));
  sleep = vi.fn<(ms: number) => Promise<void>>();
  sleep.mockResolvedValue(undefined);
  getAccessToken = vi.fn<() => Promise<string>>();
  getAccessToken.mockResolvedValue("synthetic-access");
  server = createServer(new SpotifyClient({ fetch, sleep, getAccessToken }));
  client = new Client({ name: "synthetic-catalog-tests", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
});
afterEach(async () => {
  await client.close();
  await server.close();
});
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    response,
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}
const input = { artist: "Synthetic Artist", title: "Synthetic Song" };

describe("Catalog search", () => {
  it("Given a track query and excessive limit, when searched, then caps requests and results at ten with compact metadata", async () => {
    fetch.mockResolvedValueOnce(
      searchPage(
        Array.from({ length: 15 }, (_, index) => catalogTrack(index + 1)),
      ),
    );
    const { data } = await call("search", {
      query: "Synthetic",
      type: "track",
      limit: 500,
    });
    expect(data).toMatchObject({ type: "track", limit: 10 });
    expect(data?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Synthetic Song",
          artists: ["Synthetic Artist"],
          album: "Synthetic Album",
          year: 2020,
        }),
      ]),
    );
    expect(data?.results).toHaveLength(10);
    expect(
      new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("limit"),
    ).toBe("10");
  });
  it.each(["artist", "album", "playlist", "show", "episode", "audiobook"])(
    "Given type %s, when searched, then reads the matching result collection",
    async (type) => {
      fetch.mockResolvedValueOnce(
        searchPage(
          [
            {
              name: "Synthetic Entity",
              uri: `spotify:${type}:0000000000000000000001`,
            },
          ],
          type,
        ),
      );
      expect(
        (await call("search", { query: "Synthetic", type })).data,
      ).toMatchObject({ type, results: [{ type, name: "Synthetic Entity" }] });
    },
  );
  it("Given invalid result rows, when searched, then never emits malformed or external URIs", async () => {
    fetch.mockResolvedValueOnce(
      searchPage([
        null,
        { name: "Wrong", uri: "https://example.test/track" },
        catalogTrack(),
      ]),
    );
    expect(
      (await call("search", { query: "Synthetic" })).data?.results,
    ).toHaveLength(1);
  });
});

it("Given identical titles on live and studio albums, when resolving without a version request, then prefers the studio recording", async () => {
  fetch.mockResolvedValueOnce(
    searchPage([
      catalogTrack(1, { album: "Synthetic Live Concert", year: 1990 }),
      catalogTrack(2, { album: "Synthetic Studio Album", year: 2000 }),
    ]),
  );
  expect(
    (await call("resolve_tracks", { tracks: [input] })).data,
  ).toMatchObject({ matched: [{ uri: catalogTrack(2).uri }] });
});

describe("Track identity verification", () => {
  it("Given an exact artist and title, when resolved, then returns a verified URI and high confidence", async () => {
    fetch.mockResolvedValueOnce(searchPage([catalogTrack()]));
    const { data } = await call("resolve_tracks", { tracks: [input] });
    expect(data).toMatchObject({
      matched: [{ index: 0, input, uri: catalogTrack().uri, confidence: 1 }],
      unresolved: [],
    });
    const query = new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get(
      "q",
    );
    expect(query).toBe('track:"Synthetic Song" artist:"Synthetic Artist"');
  });
  it("Given accent/case/punctuation and featured credits, when resolved, then normalizes identity without changing the track", async () => {
    fetch.mockResolvedValueOnce(
      searchPage([
        catalogTrack(1, {
          name: "Sýnthétic Song (feat. Test Guest) - 2011 Remaster",
          artists: ["Sýnthétic Artist", "Test Guest"],
        }),
      ]),
    );
    expect(
      (
        await call("resolve_tracks", {
          tracks: [
            {
              artist: "SYNTHETIC ARTIST feat. Test Guest",
              title: "synthetic song",
            },
          ],
        })
      ).data,
    ).toMatchObject({
      matched: [{ uri: catalogTrack().uri, confidence: 0.98 }],
      unresolved: [],
    });
  });
  it.each([
    catalogTrack(2, { name: "Different Song" }),
    catalogTrack(2, { artists: ["Different Artist"] }),
    catalogTrack(2, { name: "Synthetic Song - Live" }),
    catalogTrack(2, { name: "Synthetic Song - Other Remix" }),
    catalogTrack(2, { name: "Synthetic Songs" }),
  ])(
    "Given the wrong artist/title/version %j, when resolved, then keeps it unresolved and hides its URI",
    async (candidate) => {
      fetch.mockImplementation(async () => searchPage([candidate]));
      const { data } = await call("resolve_tracks", { tracks: [input] });
      expect(data?.matched).toEqual([]);
      expect(data?.unresolved).toHaveLength(1);
      expect(JSON.stringify(data?.unresolved)).not.toContain(candidate.uri);
    },
  );
  it("Given studio and live candidates, when no live version is requested, then prefers the studio recording", async () => {
    fetch.mockResolvedValueOnce(
      searchPage([
        catalogTrack(2, { name: "Synthetic Song - Live" }),
        catalogTrack(1),
      ]),
    );
    expect(
      (await call("resolve_tracks", { tracks: [input] })).data,
    ).toMatchObject({ matched: [{ uri: catalogTrack(1).uri }] });
  });
  it("Given an explicit remix, when resolving, then requires that specific version", async () => {
    fetch.mockResolvedValueOnce(
      searchPage([
        catalogTrack(2, { name: "Synthetic Song - Other Remix" }),
        catalogTrack(3, { name: "Synthetic Song (Test Remix)" }),
      ]),
    );
    expect(
      (
        await call("resolve_tracks", {
          tracks: [{ ...input, title: "Synthetic Song - Test Remix" }],
        })
      ).data,
    ).toMatchObject({ matched: [{ uri: catalogTrack(3).uri }] });
  });
  it("Given a nonexistent suggestion, when neither search finds it, then returns unresolved without a URI", async () => {
    fetch.mockImplementation(async () => searchPage([]));
    expect((await call("resolve_tracks", { tracks: [input] })).data).toEqual({
      matched: [],
      unresolved: [{ index: 0, input, reason: "not_found" }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("Given rejected field filters, when resolving, then falls back to a plain query", async () => {
    fetch
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Synthetic unsupported filter" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(searchPage([catalogTrack()]));
    expect(
      (await call("resolve_tracks", { tracks: [input] })).data,
    ).toMatchObject({ matched: [{ uri: catalogTrack().uri }] });
    expect(
      new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get("q"),
    ).toBe("Synthetic Song Synthetic Artist");
  });
  it("Given empty filtered results, when plain search finds a match, then returns that verified identity", async () => {
    fetch
      .mockResolvedValueOnce(searchPage([]))
      .mockResolvedValueOnce(searchPage([catalogTrack()]));
    expect(
      (await call("resolve_tracks", { tracks: [input] })).data,
    ).toMatchObject({ matched: [{ uri: catalogTrack().uri }] });
  });
  it("Given a matching but unavailable track, when resolved, then remains unresolved", async () => {
    fetch.mockImplementation(async () =>
      searchPage([catalogTrack(1, { playable: false })]),
    );
    expect(
      (await call("resolve_tracks", { tracks: [input] })).data,
    ).toMatchObject({ matched: [], unresolved: [{ reason: "not_playable" }] });
  });
  it("Given forty inputs and a 429, when resolving, then preserves input order and honors Retry-After", async () => {
    let rateLimited = false;
    fetch.mockImplementation(async (value) => {
      if (!rateLimited) {
        rateLimited = true;
        return Response.json(
          { error: { message: "Synthetic rate limit" } },
          { status: 429, headers: { "Retry-After": "2" } },
        );
      }
      const query = new URL(String(value)).searchParams.get("q") ?? "";
      const index = Number(query.match(/Synthetic Song (\d+)/)?.[1]);
      return searchPage([
        catalogTrack(index + 1, { name: `Synthetic Song ${index}` }),
      ]);
    });
    const tracks = Array.from({ length: 40 }, (_, index) => ({
      artist: input.artist,
      title: `Synthetic Song ${index}`,
    }));
    const { data } = await call("resolve_tracks", { tracks });
    expect(
      ((data?.matched ?? []) as { index: number }[]).map(
        (value) => value.index,
      ),
    ).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(data?.unresolved).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });
  it("Given repeated suggestions, when resolving, then reuses work while preserving each input index", async () => {
    fetch.mockResolvedValueOnce(searchPage([catalogTrack()]));
    const { data } = await call("resolve_tracks", { tracks: [input, input] });
    expect(
      ((data?.matched ?? []) as { index: number }[]).map(
        (value) => value.index,
      ),
    ).toEqual([0, 1]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[], Array(51).fill(input), [{ artist: "", title: "Synthetic" }]])(
    "Given invalid batch input %j, when resolving, then rejects it before HTTP",
    async (tracks) => {
      expect((await call("resolve_tracks", { tracks })).response.isError).toBe(
        true,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["search", "resolve_tracks"])(
    "Given no login, when %s runs, then returns auth instructions without HTTP",
    async (name) => {
      getAccessToken.mockRejectedValue(new LoginRequiredError());
      const args =
        name === "search" ? { query: "Synthetic" } : { tracks: [input] };
      const { response } = await call(name, args);
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("pnpm auth");
      expect(fetch).not.toHaveBeenCalled();
      await expect(client.ping()).resolves.toEqual({});
    },
  );
});
