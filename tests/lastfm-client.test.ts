import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LastfmClient, RequestBudget } from "../src/lastfm/client.js";
import { loadLastfmApiKey, saveLastfmApiKey } from "../src/lastfm/config.js";

const key = "a".repeat(32);
const tagged = {
  toptags: {
    tag: [{ name: "Jazz", count: "75", url: "http://www.last.fm/tag/jazz" }],
  },
};

describe("Last.fm candidate methods", () => {
  it.each(["tag", "seed"])(
    "Given a %s discovery source, when fetched, then uses the read-only endpoint, bounded limit and safe provenance",
    async (kind) => {
      const { client, fetch } = harness();
      const row = {
        name: "Synthetic Song",
        artist: { name: "Synthetic Artist" },
        match: "49.5",
        "@attr": { rank: "7" },
        url: "http://www.last.fm/music/Synthetic/_/Song?api_key=private#fragment",
      };
      fetch.mockResolvedValueOnce(
        Response.json({
          [kind === "tag" ? "tracks" : "similartracks"]: { track: row },
        }),
      );
      const options = { budget: new RequestBudget(1) };
      const result =
        kind === "tag"
          ? await client.getTagTracks("uptempo", 500, options)
          : await client.getSimilarTracks(
              "Synthetic Artist",
              "Synthetic Song",
              500,
              options,
            );
      const url = new URL(String(fetch.mock.calls[0]?.[0]));
      expect(url.origin).toBe("https://ws.audioscrobbler.com");
      expect(url.searchParams.get("method")).toBe(
        kind === "tag" ? "tag.getTopTracks" : "track.getSimilar",
      );
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get(kind === "tag" ? "tag" : "artist")).toBe(
        kind === "tag" ? "uptempo" : "Synthetic Artist",
      );
      if (kind === "seed")
        expect(url.searchParams.get("autocorrect")).toBe("0");
      expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
      expect(result.candidates).toEqual([
        {
          artist: "Synthetic Artist",
          title: "Synthetic Song",
          rank: 7,
          similarity_score: 49.5,
          source_url: "https://www.last.fm/music/Synthetic/_/Song",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain(key);
    },
  );

  it("Given mixed malformed candidates and unsafe URLs, when parsed, then skips invalid rows and replaces unsafe links", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValueOnce(
      Response.json({
        tracks: {
          track: [
            { name: "Incomplete" },
            {
              name: "Synthetic Song",
              artist: "Synthetic Artist",
              url: "https://evil.example/track",
              match: "invalid",
            },
          ],
        },
      }),
    );
    const result = await client.getTagTracks("jazz", 2, {
      budget: new RequestBudget(1),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      artist: "Synthetic Artist",
      title: "Synthetic Song",
      rank: 2,
    });
    expect(result.candidates[0]?.source_url).toMatch(
      /^https:\/\/www\.last\.fm\/music\//,
    );
    expect(result.candidates[0]).not.toHaveProperty("similarity_score");
  });

  it.each([
    { tracks: {} },
    { tracks: { track: [] } },
    { tracks: { track: "" } },
  ])(
    "Given an empty tag chart %j, when parsed, then returns a cacheable empty source",
    async (body) => {
      const { client, fetch } = harness();
      fetch.mockResolvedValueOnce(Response.json(body));
      expect(
        (await client.getTagTracks("jazz", 2, { budget: new RequestBudget(1) }))
          .candidates,
      ).toEqual([]);
    },
  );

  it.each([
    {},
    { tracks: { track: [{ unrelated: true }] } },
    { tracks: { track: "invalid" } },
  ])(
    "Given malformed discovery data %j, when parsed, then reports an API failure instead of silently caching no matches",
    async (body) => {
      const { client, fetch } = harness();
      fetch.mockResolvedValueOnce(Response.json(body));
      await expect(
        client.getTagTracks("jazz", 2, { budget: new RequestBudget(1) }),
      ).rejects.toThrow("Last.fm");
    },
  );

  it("Given HTTP 200 rate limit code 29, when discovery retries, then honors Retry-After and counts both attempts", async () => {
    const { client, fetch, sleep } = harness({ maxRetries: 1 });
    fetch
      .mockResolvedValueOnce(
        Response.json(
          { error: 29, message: "Rate limited" },
          { headers: { "Retry-After": "2" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ similartracks: { track: [] } }));
    const budget = new RequestBudget(2);
    expect(
      (
        await client.getSimilarTracks("Synthetic Artist", "Synthetic Song", 2, {
          budget,
        })
      ).candidates,
    ).toEqual([]);
    expect(budget.used).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Given discovery no-store headers, when fetched, then carries the provider cache restriction", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValueOnce(
      Response.json(
        { tracks: { track: [] } },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
    expect(
      (await client.getTagTracks("jazz", 2, { budget: new RequestBudget(1) }))
        .cacheTtlMs,
    ).toBe(0);
  });
});
function harness(options: { maxRetries?: number } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const sleep = vi.fn<(ms: number) => Promise<void>>();
  sleep.mockResolvedValue(undefined);
  const getApiKey = vi.fn<() => Promise<string>>();
  getApiKey.mockResolvedValue(key);
  return {
    fetch,
    sleep,
    getApiKey,
    client: new LastfmClient({
      fetch,
      sleep,
      getApiKey,
      minIntervalMs: 0,
      ...options,
    }),
  };
}

describe("Last.fm HTTP", () => {
  it.each(["artist", "track"] as const)(
    "Given a %s tag lookup, when requested, then sends only a read method to the fixed HTTPS endpoint",
    async (level) => {
      const { client, fetch } = harness();
      fetch.mockResolvedValueOnce(Response.json(tagged));
      const result = await client.getTopTags(
        level,
        "Synthetic Artist & Name",
        "Synthetic Title",
        { budget: new RequestBudget(3) },
      );
      const url = new URL(String(fetch.mock.calls[0]?.[0]));
      expect(url.origin).toBe("https://ws.audioscrobbler.com");
      expect(url.pathname).toBe("/2.0/");
      expect(url.searchParams.get("method")).toBe(`${level}.getTopTags`);
      expect(url.searchParams.get("artist")).toBe("Synthetic Artist & Name");
      expect(url.searchParams.get("api_key")).toBe(key);
      expect(url.searchParams.get("autocorrect")).toBe("0");
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
      expect(result.tags).toEqual([
        {
          name: "Jazz",
          normalized: "jazz",
          count: 75,
          url: "https://www.last.fm/tag/jazz",
        },
      ]);
      expect(result.sourceUrl).toContain("https://www.last.fm/music/");
      expect(JSON.stringify(result)).not.toContain(key);
    },
  );
  it("Given duplicate tag spellings and unsafe URLs, when parsed, then normalizes labels and preserves the strongest original evidence", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValueOnce(
      Response.json({
        toptags: {
          tag: [
            { name: "Jazz", count: 5 },
            { name: " JAZZ ", count: "20", url: "javascript:unsafe" },
            {
              name: "Uptempo",
              url: "https://www.last.fm/tag/uptempo?api_key=private#fragment",
            },
            { name: "  " },
          ],
        },
      }),
    );
    const result = await client.getTopTags("track", "Synthetic", "Track", {
      budget: new RequestBudget(2),
    });
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0]).toMatchObject({
      name: " JAZZ ",
      normalized: "jazz",
      count: 20,
    });
    expect(result.tags[0]?.url).toMatch(/^https:\/\/www.last.fm\/tag\//);
    expect(result.tags[1]).toMatchObject({
      count: null,
      url: "https://www.last.fm/tag/uptempo",
    });
  });
  it.each([
    { toptags: { tag: [] } },
    { toptags: { tag: "" } },
    { toptags: {} },
  ])(
    "Given empty tag data %j, when parsed, then returns an honest empty result",
    async (body) => {
      const { client, fetch } = harness();
      fetch.mockResolvedValueOnce(Response.json(body));
      await expect(
        client.getTopTags("artist", "Synthetic Artist", null, {
          budget: new RequestBudget(1),
        }),
      ).resolves.toMatchObject({ tags: [], notFound: false });
    },
  );
  it("Given an HTTP 200 invalid-key payload, when requested, then reports code 10 without echoing the key or retrying", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValueOnce(
      Response.json({ error: 10, message: `Bad key ${key}` }),
    );
    const result = client.getTopTags("artist", "Synthetic", null, {
      budget: new RequestBudget(3),
    });
    await expect(result).rejects.toMatchObject({ code: 10 });
    await expect(result).rejects.toThrow("lastfm:configure");
    await expect(result).rejects.not.toThrow(key);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given an HTTP 200 not-found payload, when requested, then returns a negative-cacheable empty result", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValueOnce(
      Response.json({ error: 6, message: "Track not found" }),
    );
    await expect(
      client.getTopTags("track", "Synthetic", "Missing", {
        budget: new RequestBudget(1),
      }),
    ).resolves.toMatchObject({ notFound: true, tags: [] });
  });
  it("Given code 29 and Retry-After, when rate limited, then waits at least the requested delay before retrying", async () => {
    const { client, fetch, sleep } = harness();
    fetch
      .mockResolvedValueOnce(
        Response.json(
          { error: 29, message: "Slow down" },
          { headers: { "Retry-After": "2" } },
        ),
      )
      .mockResolvedValueOnce(Response.json(tagged));
    await expect(
      client.getTopTags("artist", "Synthetic", null, {
        budget: new RequestBudget(3),
      }),
    ).resolves.toMatchObject({ tags: [{ name: "Jazz" }] });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("Given a non-JSON HTTP 503, when temporarily unavailable, then retries safely as a read", async () => {
    const { client, fetch, sleep } = harness();
    fetch
      .mockResolvedValueOnce(
        new Response("gateway unavailable", { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(tagged));
    await expect(
      client.getTopTags("artist", "Synthetic", null, {
        budget: new RequestBudget(3),
      }),
    ).resolves.toMatchObject({ tags: [{ name: "Jazz" }] });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
  it("Given persistent rate limits, when retry allowance ends, then stops with a readable error", async () => {
    const { client, fetch } = harness({ maxRetries: 1 });
    fetch.mockImplementation(async () =>
      Response.json({ error: 29, message: key }),
    );
    const result = client.getTopTags("artist", "Synthetic", null, {
      budget: new RequestBudget(5),
    });
    await expect(result).rejects.toThrow("rate limit");
    await expect(result).rejects.not.toThrow(key);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("Given a one-request budget, when the first attempt is rate limited, then never retries beyond the budget", async () => {
    const { client, fetch, sleep } = harness();
    fetch.mockResolvedValueOnce(Response.json({ error: 29 }));
    const budget = new RequestBudget(1);
    await expect(
      client.getTopTags("artist", "Synthetic", null, { budget }),
    ).rejects.toMatchObject({ code: 29 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("Given a transport error containing the secret URL, when it fails, then redacts it from the surfaced error", async () => {
    const { client, fetch } = harness({ maxRetries: 0 });
    fetch.mockRejectedValueOnce(
      new TypeError(`Failed https://ws.audioscrobbler.com/?api_key=${key}`),
    );
    const result = client.getTopTags("artist", "Synthetic", null, {
      budget: new RequestBudget(1),
    });
    await expect(result).rejects.toThrow("Last.fm request failed");
    await expect(result).rejects.not.toThrow(key);
  });
  it("Given concurrent lookups, when queued, then spaces requests without duplicating or writing to either provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const starts: number[] = [];
    let now = 0;
    fetch.mockImplementation(async () => {
      starts.push(now);
      return Response.json(tagged);
    });
    const client = new LastfmClient({
      fetch,
      getApiKey: async () => key,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await Promise.all([
      client.getTopTags("artist", "Synthetic One", null, {
        budget: new RequestBudget(1),
      }),
      client.getTopTags("artist", "Synthetic Two", null, {
        budget: new RequestBudget(1),
      }),
    ]);
    expect(starts).toEqual([0, 250]);
    expect(
      fetch.mock.calls.every(([, options]) => options?.method === "GET"),
    ).toBe(true);
  });
});

it("Given local Last.fm setup, when a key is saved and loaded, then restricts file permissions and never echoes malformed contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spotify-mcp-lastfm-config-"));
  try {
    await saveLastfmApiKey(key, directory);
    expect((await stat(join(directory, "lastfm.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(loadLastfmApiKey(directory, {})).resolves.toBe(key);
    await expect(
      loadLastfmApiKey(directory, { LASTFM_API_KEY: "b".repeat(32) }),
    ).resolves.toBe("b".repeat(32));
    await expect(
      saveLastfmApiKey("invalid synthetic private value", directory),
    ).rejects.not.toThrow("invalid synthetic private value");
    expect(
      JSON.parse(await readFile(join(directory, "lastfm.json"), "utf8")).apiKey,
    ).toBe(key);
    await writeFile(
      join(directory, "lastfm.json"),
      "synthetic-private-contents",
    );
    await expect(loadLastfmApiKey(directory, {})).rejects.toThrow(
      "lastfm:configure",
    );
    await expect(loadLastfmApiKey(directory, {})).rejects.not.toThrow(
      "synthetic-private-contents",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
