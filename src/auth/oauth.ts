import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { SpotifyTokens } from "./token-store.js";

export const REDIRECT_URI = "http://127.0.0.1:8888/callback";
export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
] as const;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export class OAuthTokenError extends Error {
  override readonly name = "OAuthTokenError";

  constructor(
    readonly status: number,
    readonly loginRequired: boolean,
  ) {
    super(`Spotify token request failed (HTTP ${status}).`);
  }
}

export function createAuthorizationRequest(clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SPOTIFY_SCOPES.join(" "),
  }).toString();
  return { authorizationUrl: url.href, verifier, state };
}

interface TokenRequestOptions {
  clientId: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

async function requestTokens(
  parameters: URLSearchParams,
  options: TokenRequestOptions,
  previous?: SpotifyTokens,
): Promise<SpotifyTokens> {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach Spotify's token endpoint. Try again.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Spotify returned an invalid token response (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    const loginRequired =
      error.success &&
      ["invalid_grant", "invalid_client"].includes(error.data.error);
    throw new OAuthTokenError(response.status, loginRequired);
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new Error("Spotify returned an invalid token response.");
  const refreshToken = parsed.data.refresh_token ?? previous?.refreshToken;
  if (!refreshToken)
    throw new Error(
      "Spotify did not return a refresh token. Run `pnpm auth` again.",
    );
  return {
    clientId: options.clientId,
    accessToken: parsed.data.access_token,
    refreshToken,
    expiresAt: (options.now ?? Date.now)() + parsed.data.expires_in * 1_000,
    scope: parsed.data.scope ?? previous?.scope ?? "",
  };
}

export function exchangeAuthorizationCode(
  options: TokenRequestOptions & { code: string; verifier: string },
): Promise<SpotifyTokens> {
  return requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: options.clientId,
      code: options.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: options.verifier,
    }),
    options,
  );
}

export function refreshTokens(
  previous: SpotifyTokens,
  options: TokenRequestOptions,
): Promise<SpotifyTokens> {
  return requestTokens(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: options.clientId,
      refresh_token: previous.refreshToken,
    }),
    options,
    previous,
  );
}
