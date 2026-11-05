import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyApiError, SpotifyClient } from "../src/spotify/client.js";

function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, { status, headers });
}

function harness(
  options: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const getAccessToken = vi.fn().mockResolvedValue("synthetic-access-token");
  return {
    fetch,
    getAccessToken,
    client: new SpotifyClient({ fetch, getAccessToken, ...options }),
  };
}

afterEach(() => vi.useRealTimers());

describe("Spotify HTTP requests", () => {
  it("Given a token, when requesting an endpoint, then sends bearer auth and returns JSON", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValue(json({ id: "synthetic-user" }));

    await expect(client.request("/me")).resolves.toEqual({
      id: "synthetic-user",
    });
    expect(fetch).toHaveBeenCalledWith("https://api.spotify.com/v1/me", {
      method: "GET",
      headers: {
        Authorization: "Bearer synthetic-access-token",
        Accept: "application/json",
      },
      redirect: "error",
    });
  });

  it("Given a JSON write, when sent, then preserves its method and serialized body", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValue(json({ id: "synthetic-playlist" }));
    await client.request("/me/playlists", {
      method: "POST",
      body: { name: "Synthetic mix" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.spotify.com/v1/me/playlists",
      expect.objectContaining({
        method: "POST",
        body: '{"name":"Synthetic mix"}',
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("Given a 204 response, when a request completes, then does not parse an empty body", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      client.request("/me/player/pause", { method: "PUT" }),
    ).resolves.toBeUndefined();
  });

  it.each([
    [401, "The access token expired"],
    [403, "Insufficient client scope"],
    [404, "Resource not found"],
    [500, "Internal server error"],
  ])(
    "Given HTTP %i, when a request fails, then includes the status and Spotify message without retrying",
    async (status, message) => {
      const { client, fetch } = harness();
      fetch.mockResolvedValue(json({ error: { status, message } }, status));
      await expect(client.request("/me")).rejects.toMatchObject({
        name: "SpotifyApiError",
        status,
        message: `Spotify API error (HTTP ${status}): ${message}`,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("Given a non-JSON error, when it fails, then retains readable HTTP context", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValue(
      new Response("gateway failure", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    await expect(client.request("/me")).rejects.toThrow(
      "HTTP 502): Bad Gateway",
    );
  });

  it("Given an empty token, when requesting, then fails before sending HTTP", async () => {
    const { client, fetch, getAccessToken } = harness();
    getAccessToken.mockResolvedValue(" ");
    await expect(client.request("/me")).rejects.toThrow(
      "access token is required",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Given a network failure, when sending a write, then does not retry and risk duplicating it", async () => {
    const { client, fetch } = harness();
    fetch.mockRejectedValue(new TypeError("Network unavailable"));
    await expect(
      client.request("/me/playlists", { method: "POST", body: {} }),
    ).rejects.toThrow("Network unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://example.test/v1/me",
    "http://api.spotify.com/v1/me",
    "https://api.spotify.com/accounts",
    "https://user:pass@api.spotify.com/v1/me",
    "//example.test/v1/me",
    "../accounts",
  ])(
    "Given an unsafe URL %s, when requesting, then does not send the bearer token",
    async (path) => {
      const { client, fetch, getAccessToken } = harness();
      await expect(client.request(path)).rejects.toThrow(
        "Spotify requests must stay",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
    },
  );
});

describe("Spotify rate limits", () => {
  it("Given Retry-After: 2, when rate limited, then waits at least 2000ms before retrying", async () => {
    vi.useFakeTimers();
    const { client, fetch, getAccessToken } = harness();
    getAccessToken
      .mockResolvedValueOnce("synthetic-first-token")
      .mockResolvedValueOnce("synthetic-new-token");
    fetch
      .mockResolvedValueOnce(
        json({ error: { message: "Too many requests" } }, 429, {
          "Retry-After": "2",
        }),
      )
      .mockResolvedValueOnce(json({ ok: true }));
    const result = client.request("/me");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer synthetic-new-token",
    });
  });

  it("Given persistent 429s, when retries reach the configured limit, then returns a rate-limit error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { client, fetch } = harness({ maxRetries: 2, sleep });
    fetch.mockImplementation(async () =>
      json({ error: { message: "Too many requests" } }, 429, {
        "Retry-After": "2",
      }),
    );
    const result = client.request("/me");
    await expect(result).rejects.toBeInstanceOf(SpotifyApiError);
    await expect(result).rejects.toMatchObject({
      status: 429,
      message:
        "Spotify rate limit (HTTP 429) after 3 attempts: Too many requests",
      retryAfterMs: 2_000,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [2_000]]);
  });

  it.each([null, "invalid", "-2", ""])(
    "Given Retry-After %s, when invalid or missing, then waits a one-second fallback",
    async (header) => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const { client, fetch } = harness({ sleep });
      fetch
        .mockResolvedValueOnce(
          json(
            { error: { message: "Slow down" } },
            429,
            header === null ? {} : { "Retry-After": header },
          ),
        )
        .mockResolvedValueOnce(json({ ok: true }));
      await client.request("/me");
      expect(sleep).toHaveBeenCalledWith(1_000);
    },
  );

  it("Given an HTTP-date Retry-After, when rate limited, then waits until that date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { client, fetch } = harness({ sleep });
    fetch
      .mockResolvedValueOnce(
        json({ error: { message: "Slow down" } }, 429, {
          "Retry-After": "Thu, 01 Jan 2026 00:00:02 GMT",
        }),
      )
      .mockResolvedValueOnce(json({ ok: true }));
    await client.request("/me");
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("Given zero allowed retries, when rate limited, then returns immediately without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { client, fetch } = harness({ maxRetries: 0, sleep });
    fetch.mockResolvedValue(json({ error: { message: "Slow down" } }, 429));
    await expect(client.request("/me")).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "Given an invalid retry limit %s, when configuring the client, then rejects it",
    (maxRetries) => {
      expect(() => harness({ maxRetries })).toThrow(
        "maxRetries must be a non-negative integer",
      );
    },
  );
});

describe("Spotify pagination", () => {
  it("Given three pages, when following next links, then returns all items in page order", async () => {
    const { client, fetch } = harness();
    fetch
      .mockResolvedValueOnce(
        json({
          items: [{ id: "synthetic-a" }, { id: "synthetic-b" }],
          next: "https://api.spotify.com/v1/me/tracks?offset=2",
        }),
      )
      .mockResolvedValueOnce(
        json({
          items: [{ id: "synthetic-c" }],
          next: "https://api.spotify.com/v1/me/tracks?offset=3",
        }),
      )
      .mockResolvedValueOnce(
        json({ items: [{ id: "synthetic-d" }], next: null }),
      );
    await expect(client.getAll<{ id: string }>("/me/tracks")).resolves.toEqual([
      { id: "synthetic-a" },
      { id: "synthetic-b" },
      { id: "synthetic-c" },
      { id: "synthetic-d" },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.spotify.com/v1/me/tracks",
      "https://api.spotify.com/v1/me/tracks?offset=2",
      "https://api.spotify.com/v1/me/tracks?offset=3",
    ]);
  });

  it("Given an empty page with a next link, when paging, then continues to the next page", async () => {
    const { client, fetch } = harness();
    fetch
      .mockResolvedValueOnce(
        json({
          items: [],
          next: "https://api.spotify.com/v1/me/tracks?offset=1",
        }),
      )
      .mockResolvedValueOnce(json({ items: ["synthetic-item"], next: null }));
    await expect(client.getAll("/me/tracks")).resolves.toEqual([
      "synthetic-item",
    ]);
  });

  it("Given a repeated next link, when paging, then stops with a clear error", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValue(
      json({ items: [], next: "https://api.spotify.com/v1/me/tracks" }),
    );
    await expect(client.getAll("/me/tracks")).rejects.toThrow(
      "pagination repeated a page",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("Given an off-site next link, when paging, then never sends credentials there", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValue(
      json({ items: [], next: "https://example.test/steal" }),
    );
    await expect(client.getAll("/me/tracks")).rejects.toThrow(
      "Spotify requests must stay",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("Given a malformed page, when paging, then fails instead of returning partial data", async () => {
    const { client, fetch } = harness();
    fetch.mockResolvedValue(json({ items: [] }));
    await expect(client.getAll("/me/tracks")).rejects.toThrow("invalid page");
  });
});
