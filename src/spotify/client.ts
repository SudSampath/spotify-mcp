import { z } from "zod";
import { LoginRequiredError } from "../auth/errors.js";

export const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1/";

const errorSchema = z.object({
  error: z.object({ message: z.string() }),
});
const pageSchema = z.object({
  items: z.array(z.unknown()),
  next: z.string().nullable(),
});

export interface SpotifyClientOptions {
  getAccessToken: () => string | Promise<string>;
  /** Refresh a rejected token once; omitted for clients without OAuth recovery. */
  refreshAccessToken?: (rejectedToken: string) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  /** Number of retries after the first request. Defaults to three. */
  maxRetries?: number;
  /** Injectable clock boundary so rate-limit tests do not need real delays. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface SpotifyRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

export class SpotifyApiError extends Error {
  override readonly name = "SpotifyApiError";

  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | undefined = undefined,
  ) {
    super(message);
  }
}

function spotifyUrl(path: string): URL {
  // Endpoint paths are relative to /v1; pagination may supply absolute URLs.
  const relative = path.startsWith("/") && !path.startsWith("//");
  const url = new URL(relative ? path.slice(1) : path, SPOTIFY_API_BASE_URL);
  if (
    url.origin !== "https://api.spotify.com" ||
    !url.pathname.startsWith("/v1/") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "Spotify requests must stay under https://api.spotify.com/v1/.",
    );
  }
  return url;
}

function retryAfterMilliseconds(header: string | null): number {
  if (header !== null && /^\d+(\.\d+)?$/.test(header.trim())) {
    const milliseconds = Number(header) * 1_000;
    if (Number.isFinite(milliseconds)) return milliseconds;
  }
  const date =
    header && /^[A-Za-z]{3},\s/.test(header) ? Date.parse(header) : Number.NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1_000;
}

async function sleep(milliseconds: number): Promise<void> {
  // Node timers overflow above this value; never retry earlier than requested.
  const maxDelay = 2_147_483_647;
  for (let remaining = milliseconds; remaining > 0; remaining -= maxDelay) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(remaining, maxDelay));
    });
  }
}

async function spotifyMessage(response: Response): Promise<string> {
  try {
    const parsed = errorSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // Gateways may return an empty or non-JSON error body.
  }
  return response.statusText || "Request failed";
}

export class SpotifyClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly getAccessToken: SpotifyClientOptions["getAccessToken"];
  private readonly refreshAccessToken: SpotifyClientOptions["refreshAccessToken"];

  constructor(options: SpotifyClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? sleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error("maxRetries must be a non-negative integer.");
    }
  }

  async request<T = unknown>(
    path: string,
    options: SpotifyRequestOptions = {},
  ): Promise<T | undefined> {
    const url = spotifyUrl(path);
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    let rateLimitRetries = 0;
    let refreshed = false;
    let retryToken: string | undefined;
    for (;;) {
      const token = retryToken ?? (await this.getAccessToken());
      retryToken = undefined;
      if (!token.trim()) throw new Error("A Spotify access token is required.");
      const response = await this.fetch(url.href, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
      });

      if (response.ok) {
        if (response.status === 204) return undefined;
        return (await response.json()) as T;
      }

      const message = await spotifyMessage(response);
      if (response.status === 401 && this.refreshAccessToken) {
        if (refreshed) throw new LoginRequiredError();
        refreshed = true;
        retryToken = await this.refreshAccessToken(token);
        continue;
      }
      if (response.status === 429) {
        const wait = retryAfterMilliseconds(
          response.headers.get("Retry-After"),
        );
        if (rateLimitRetries < this.maxRetries) {
          rateLimitRetries++;
          await this.sleep(wait);
          continue;
        }
        throw new SpotifyApiError(
          429,
          `Spotify rate limit (HTTP 429) after ${rateLimitRetries + 1} attempts: ${message}`,
          wait,
        );
      }
      throw new SpotifyApiError(
        response.status,
        `Spotify API error (HTTP ${response.status}): ${message}`,
      );
    }
  }

  /** Follow Spotify's next links, preserving item order across every page. */
  async getAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    const visited = new Set<string>();
    let next: string | null = path;
    while (next !== null) {
      const url = spotifyUrl(next).href;
      if (visited.has(url))
        throw new Error("Spotify pagination repeated a page.");
      visited.add(url);
      const page = pageSchema.safeParse(await this.request(url));
      if (!page.success) throw new Error("Spotify returned an invalid page.");
      items.push(...(page.data.items as T[]));
      next = page.data.next;
    }
    return items;
  }
}
