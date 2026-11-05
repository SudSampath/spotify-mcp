import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCallbackListener } from "../src/auth/callback.js";
import { authorize } from "../src/auth/login.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  REDIRECT_URI,
  SPOTIFY_SCOPES,
} from "../src/auth/oauth.js";
import { TokenStore } from "../src/auth/token-store.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-auth-login-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("Given a new login, when building authorization, then uses unique state and an S256 PKCE challenge", () => {
  const first = createAuthorizationRequest("synthetic-client");
  const second = createAuthorizationRequest("synthetic-client");
  const url = new URL(first.authorizationUrl);
  expect(url.origin).toBe("https://accounts.spotify.com");
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(url.searchParams.get("client_id")).toBe("synthetic-client");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(first.verifier).digest("base64url"),
  );
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.state).not.toBe(second.state);
  expect(first.verifier).not.toBe(second.verifier);
  expect(url.searchParams.get("scope")?.split(" ")).toEqual([
    ...SPOTIFY_SCOPES,
  ]);
  expect(url.searchParams.has("client_secret")).toBe(false);
  expect(url.searchParams.has("code_verifier")).toBe(false);
});

describe("Loopback callback", () => {
  it("Given an unrelated request, when received, then keeps waiting for the valid callback", async () => {
    const listener = await startCallbackListener("synthetic-state", {
      port: 0,
    });
    try {
      const unrelated = await fetch(
        listener.callbackUrl.replace("/callback", "/favicon.ico"),
      );
      expect(unrelated.status).toBe(404);
      const callback = await fetch(
        `${listener.callbackUrl}?state=synthetic-state&code=synthetic-code`,
      );
      expect(callback.status).toBe(200);
      expect(callback.headers.get("Cache-Control")).toBe("no-store");
      await expect(listener.code).resolves.toBe("synthetic-code");
    } finally {
      await listener.close();
    }
  });
  it.each([
    "state=wrong-state&code=synthetic-code",
    "code=synthetic-code",
    "state=synthetic-state&state=synthetic-state&code=synthetic-code",
    "state=synthetic-state",
    "state=synthetic-state&code=one&code=two",
    "state=synthetic-state&error=access_denied",
  ])(
    "Given an invalid callback %s, when received, then rejects the login",
    async (query) => {
      const listener = await startCallbackListener("synthetic-state", {
        port: 0,
      });
      try {
        const response = await fetch(`${listener.callbackUrl}?${query}`);
        expect(response.status).toBe(400);
        await expect(listener.code).rejects.toThrow("pnpm auth");
      } finally {
        await listener.close();
      }
    },
  );
  it("Given no approval, when the callback deadline passes, then returns a timeout and releases the listener", async () => {
    const listener = await startCallbackListener("synthetic-state", {
      port: 0,
      timeoutMs: 10,
    });
    try {
      await expect(listener.code).rejects.toThrow("timed out");
    } finally {
      await listener.close();
    }
    await expect(fetch(listener.callbackUrl)).rejects.toThrow();
  });
});

describe("Authorization flow", () => {
  it("Given browser approval, when login completes, then validates state, exchanges PKCE, identifies the account and saves tokens", async () => {
    const store = new TokenStore(directory);
    const backend = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expires_in: 3_600,
          scope: SPOTIFY_SCOPES.join(" "),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "synthetic-account",
          display_name: "Synthetic Listener",
        }),
      );
    let callbackUrl = "";
    let authorizationUrl = "";
    const account = await authorize({
      clientId: "synthetic-client",
      store,
      fetch: backend,
      listen: async (state) => {
        const listener = await startCallbackListener(state, { port: 0 });
        callbackUrl = listener.callbackUrl;
        return listener;
      },
      openBrowser: async (url) => {
        authorizationUrl = url;
        const state = new URL(url).searchParams.get("state");
        const response = await fetch(
          `${callbackUrl}?state=${state}&code=synthetic-code`,
        );
        expect(response.status).toBe(200);
      },
    });
    expect(account).toEqual({
      id: "synthetic-account",
      displayName: "Synthetic Listener",
    });
    expect(backend).toHaveBeenCalledTimes(2);
    expect(backend.mock.calls[0]?.[0]).toBe(
      "https://accounts.spotify.com/api/token",
    );
    const request = backend.mock.calls[0]?.[1];
    expect(request?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(String(request?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("synthetic-code");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(body.has("client_secret")).toBe(false);
    expect(
      createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(new URL(authorizationUrl).searchParams.get("code_challenge"));
    expect(backend.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer synthetic-access",
    });
    await expect(store.read()).resolves.toMatchObject({
      clientId: "synthetic-client",
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
    });
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });
  it("Given mismatched state, when the callback arrives, then sends no token request and saves nothing", async () => {
    const store = new TokenStore(directory);
    const backend = vi.fn<typeof globalThis.fetch>();
    let callbackUrl = "";
    await expect(
      authorize({
        clientId: "synthetic-client",
        store,
        fetch: backend,
        listen: async (state) => {
          const listener = await startCallbackListener(state, { port: 0 });
          callbackUrl = listener.callbackUrl;
          return listener;
        },
        openBrowser: async () => {
          await fetch(`${callbackUrl}?state=wrong&code=synthetic-code`);
        },
      }),
    ).rejects.toThrow("state did not match");
    expect(backend).not.toHaveBeenCalled();
    await expect(store.read()).resolves.toBeNull();
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });
  it("Given a browser-opening failure, when login stops, then closes the loopback listener", async () => {
    let callbackUrl = "";
    await expect(
      authorize({
        clientId: "synthetic-client",
        store: new TokenStore(directory),
        listen: async (state) => {
          const listener = await startCallbackListener(state, { port: 0 });
          callbackUrl = listener.callbackUrl;
          return listener;
        },
        openBrowser: async () => {
          throw new Error("Synthetic browser failure");
        },
      }),
    ).rejects.toThrow("Synthetic browser failure");
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });
  it("Given a bad token response containing private text, when the exchange fails, then never echoes that text", async () => {
    const backend = vi.fn<typeof globalThis.fetch>();
    backend.mockResolvedValueOnce(
      Response.json(
        {
          error: "invalid_grant",
          error_description: "synthetic-private-value",
        },
        { status: 400 },
      ),
    );
    await expect(
      exchangeAuthorizationCode({
        clientId: "synthetic-client",
        code: "synthetic-code",
        verifier: "synthetic-verifier",
        fetch: backend,
      }),
    ).rejects.toMatchObject({
      message: "Spotify token request failed (HTTP 400).",
      loginRequired: true,
    });
  });
});
