import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_REQUIRED_MESSAGE,
  LoginRequiredError,
} from "../src/auth/errors.js";
import { TokenManager } from "../src/auth/token-manager.js";
import { type SpotifyTokens, TokenStore } from "../src/auth/token-store.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { runSpotifyTool } from "../src/spotify/session.js";

let directory: string;
const now = 1_800_000_000_000;
const original: SpotifyTokens = {
  clientId: "synthetic-client",
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
  expiresAt: now + 3_600_000,
  scope: "user-library-read",
};
const refreshed = {
  access_token: "synthetic-new-access",
  token_type: "Bearer",
  expires_in: 3_600,
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-auth-session-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function harness() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const store = new TokenStore(directory);
  const manager = new TokenManager({
    store,
    fetch,
    getClientId: async () => original.clientId,
    now: () => now,
  });
  const client = new SpotifyClient({
    fetch,
    getAccessToken: manager.getAccessToken,
    refreshAccessToken: manager.refreshAccessToken,
  });
  return { fetch, store, manager, client };
}

describe("Token refresh", () => {
  it("Given valid tokens, when accessing Spotify, then reuses them without a refresh", async () => {
    const { store, manager, fetch } = harness();
    await store.write(original);
    await expect(manager.getAccessToken()).resolves.toBe(original.accessToken);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Given expired tokens, when an API call is made, then refreshes first and preserves an unrotated refresh token", async () => {
    const { store, fetch, client } = harness();
    await store.write({ ...original, expiresAt: now - 1 });
    fetch
      .mockResolvedValueOnce(Response.json(refreshed))
      .mockResolvedValueOnce(Response.json({ id: "synthetic-user" }));
    await expect(client.request("/me")).resolves.toEqual({
      id: "synthetic-user",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://accounts.spotify.com/api/token",
      "https://api.spotify.com/v1/me",
    ]);
    expect(
      new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get(
        "grant_type",
      ),
    ).toBe("refresh_token");
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer synthetic-new-access",
    });
    await expect(store.read()).resolves.toMatchObject({
      accessToken: refreshed.access_token,
      refreshToken: original.refreshToken,
      expiresAt: now + 3_600_000,
      scope: original.scope,
    });
  });
  it("Given a token expiring in 20 seconds, when accessed, then refreshes before expiry", async () => {
    const { store, manager, fetch } = harness();
    await store.write({ ...original, expiresAt: now + 20_000 });
    fetch.mockResolvedValueOnce(Response.json(refreshed));
    await expect(manager.getAccessToken()).resolves.toBe(
      refreshed.access_token,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given a rotated refresh token, when refreshed, then persists the replacement", async () => {
    const { store, manager, fetch } = harness();
    await store.write({ ...original, expiresAt: now - 1 });
    fetch.mockResolvedValueOnce(
      Response.json({
        ...refreshed,
        refresh_token: "synthetic-rotated-refresh",
      }),
    );
    await manager.getAccessToken();
    await expect(store.read()).resolves.toMatchObject({
      refreshToken: "synthetic-rotated-refresh",
    });
  });
  it("Given concurrent calls with expired tokens, when refreshing, then sends only one refresh request", async () => {
    const { store, manager, fetch } = harness();
    await store.write({ ...original, expiresAt: now - 1 });
    fetch.mockImplementation(async () => Response.json(refreshed));
    await expect(
      Promise.all([
        manager.getAccessToken(),
        manager.getAccessToken(),
        manager.getAccessToken(),
      ]),
    ).resolves.toEqual(Array(3).fill(refreshed.access_token));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given a revoked refresh token, when refreshed, then removes it and asks for login", async () => {
    const { store, manager, fetch } = harness();
    await store.write({ ...original, expiresAt: now - 1 });
    fetch.mockResolvedValueOnce(
      Response.json(
        {
          error: "invalid_grant",
          error_description: "synthetic-private-value",
        },
        { status: 400 },
      ),
    );
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(
      LoginRequiredError,
    );
    await expect(store.read()).resolves.toBeNull();
    await expect(manager.getAccessToken()).rejects.toThrow("pnpm auth");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given a transient refresh failure, when Spotify is unavailable, then keeps credentials for a later retry", async () => {
    const { store, manager, fetch } = harness();
    await store.write({ ...original, expiresAt: now - 1 });
    fetch
      .mockResolvedValueOnce(
        Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(refreshed));
    await expect(manager.getAccessToken()).rejects.toThrow("HTTP 503");
    await expect(store.read()).resolves.toMatchObject({
      refreshToken: original.refreshToken,
    });
    await expect(manager.getAccessToken()).resolves.toBe(
      refreshed.access_token,
    );
  });
  it("Given tokens for a different app, when accessed, then asks for login without sending them", async () => {
    const { store, manager, fetch } = harness();
    await store.write({ ...original, clientId: "synthetic-different-app" });
    await expect(manager.getAccessToken()).rejects.toThrow("pnpm auth");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("401 recovery", () => {
  it("Given a valid-looking token rejected with 401, when requesting, then refreshes and retries once", async () => {
    const { store, fetch, client } = harness();
    await store.write(original);
    fetch
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Expired" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json(refreshed))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(client.request("/me")).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.spotify.com/v1/me",
      "https://accounts.spotify.com/api/token",
      "https://api.spotify.com/v1/me",
    ]);
    expect(fetch.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer synthetic-new-access",
    });
  });
  it("Given a second 401 after refresh, when requesting, then asks for login and never loops", async () => {
    const { store, fetch, client } = harness();
    await store.write(original);
    fetch
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Expired" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json(refreshed))
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Still invalid" } }, { status: 401 }),
      );
    await expect(client.request("/me")).rejects.toThrow(LOGIN_REQUIRED_MESSAGE);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("Given a late 401 for an old token, when another call already refreshed, then reuses the newer token", async () => {
    const { store, manager, fetch } = harness();
    await store.write({
      ...original,
      accessToken: "synthetic-already-refreshed",
    });
    await expect(
      manager.refreshAccessToken("synthetic-old-rejected"),
    ).resolves.toBe("synthetic-already-refreshed");
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("Given a server without tokens, when a Spotify tool fails, then returns login instructions and stays usable after local login", async () => {
  const { store, client: spotify, fetch } = harness();
  const server = createServer(spotify);
  server.registerTool(
    "test_spotify_access",
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    () =>
      runSpotifyTool(async () => ({
        content: [
          { type: "text", text: JSON.stringify(await spotify.request("/me")) },
        ],
      })),
  );
  const client = new Client({ name: "synthetic-auth-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "test_spotify_access" });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: LOGIN_REQUIRED_MESSAGE }],
    });
    expect(JSON.stringify(result)).not.toContain("stack");
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.ping()).resolves.toEqual({});
    await store.write(original);
    fetch.mockResolvedValueOnce(Response.json({ id: "synthetic-user" }));
    await expect(
      client.callTool({ name: "test_spotify_access" }),
    ).resolves.not.toHaveProperty("isError", true);
    await expect(client.ping()).resolves.toEqual({});
  } finally {
    await client.close();
    await server.close();
  }
});
