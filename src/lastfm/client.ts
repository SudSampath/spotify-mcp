import { z } from "zod";
import { loadLastfmApiKey } from "./config.js";
import {
  type LastfmCandidate,
  type LastfmCandidateSource,
  type LastfmTag,
  normalizeTag,
  type TagLevel,
} from "./types.js";

const ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
const explanations: Record<number, string> = {
  6: "The requested artist or track could not be found.",
  8: "Last.fm could not complete the request.",
  10: "The API key is invalid. Run `pnpm lastfm:configure` again.",
  11: "Last.fm is temporarily offline.",
  16: "Last.fm reported a temporary error.",
  26: "The API key is disabled. Check your Last.fm API account.",
  29: "Last.fm rate limit reached. Try again later.",
};

export class LastfmApiError extends Error {
  override readonly name = "LastfmApiError";
  constructor(
    readonly status: number | undefined,
    readonly code: number | undefined,
  ) {
    super(
      `Last.fm request failed${status === undefined ? "" : ` (HTTP ${status})`}${code === undefined ? "" : `, code ${code}`}. ${code === undefined ? "Try again later." : (explanations[code] ?? "Check the Last.fm request and try again.")}`,
    );
  }
}

export class RequestBudgetExceeded extends Error {
  override readonly name = "RequestBudgetExceeded";
  constructor() {
    super("The Last.fm request budget for this call has been exhausted.");
  }
}

export class RequestBudget {
  used = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Last.fm request budget must be a positive integer.");
  }
  take(): void {
    if (this.used >= this.limit) throw new RequestBudgetExceeded();
    this.used++;
  }
}

interface RequestOptions {
  budget: RequestBudget;
  signal?: AbortSignal | undefined;
}
interface ClientOptions {
  getApiKey?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  minIntervalMs?: number;
}

const rawTag = z.object({
  name: z.string(),
  count: z.union([z.number(), z.string()]).optional(),
  url: z.string().optional(),
});
const tagsSchema = z.object({
  toptags: z.object({
    tag: z.union([z.array(rawTag), rawTag, z.literal("")]).optional(),
  }),
});

function sourceUrl(level: TagLevel, artist: string, title?: string): string {
  const base = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
  return level === "track"
    ? `${base}/_/${encodeURIComponent(title ?? "")}`
    : base;
}

function safeLastfmUrl(value: string | undefined, fallback: string): string {
  try {
    const url = new URL(
      value?.startsWith("www.") ? `https://${value}` : (value ?? ""),
    );
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      (url.hostname === "last.fm" || url.hostname.endsWith(".last.fm")) &&
      !url.username &&
      !url.password
    ) {
      url.protocol = "https:";
      url.search = "";
      url.hash = "";
      return url.href;
    }
  } catch {
    /* Use a canonical Last.fm tag URL for absent or unsafe provider URLs. */
  }
  return fallback;
}

function tagUrl(value: string | undefined, name: string): string {
  return safeLastfmUrl(
    value,
    `https://www.last.fm/tag/${encodeURIComponent(name)}`,
  );
}

function retryDelay(
  value: string | null,
  fallback: number,
  now: number,
): number {
  if (value && /^\d+(\.\d+)?$/.test(value.trim())) {
    const delay = Number(value) * 1_000;
    if (Number.isFinite(delay)) return Math.max(delay, fallback);
  }
  const date =
    value && /^[A-Za-z]{3},\s/.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(date) ? Math.max(date - now, fallback) : fallback;
}

function cacheLifetime(headers: Headers, now: number): number | undefined {
  const control = headers.get("Cache-Control") ?? "";
  if (
    /(?:^|,)\s*(?:no-store|no-cache)(?:\s|,|$)/i.test(control) ||
    headers.get("Pragma")?.toLowerCase().includes("no-cache")
  )
    return 0;
  const maxAge = control.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i)?.[1];
  if (maxAge !== undefined) {
    const lifetime = (Number(maxAge) - Number(headers.get("Age") ?? 0)) * 1_000;
    if (Number.isFinite(lifetime)) return Math.max(0, lifetime);
  }
  const expires = headers.get("Expires");
  const date = expires ? Date.parse(expires) : Number.NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export class LastfmClient {
  private readonly getApiKey: () => Promise<string>;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly minInterval: number;
  private queued: Promise<unknown> = Promise.resolve();
  private lastStarted: number | undefined;

  constructor(options: ClientOptions = {}) {
    this.getApiKey = options.getApiKey ?? (() => loadLastfmApiKey());
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.maxRetries = options.maxRetries ?? 2;
    this.minInterval = options.minIntervalMs ?? 250;
    if (
      !Number.isSafeInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 5 ||
      !Number.isFinite(this.minInterval) ||
      this.minInterval < 0
    )
      throw new Error("Invalid Last.fm retry or pacing configuration.");
  }

  getTopTags(
    level: TagLevel,
    artist: string,
    title: string | null,
    options: RequestOptions,
  ): Promise<{
    tags: LastfmTag[];
    sourceUrl: string;
    notFound: boolean;
    cacheTtlMs: number | undefined;
  }> {
    const operation = this.queued.then(() =>
      this.lookup(level, artist, title, options),
    );
    this.queued = operation.catch(() => {});
    return operation;
  }

  getTagTracks(
    tag: string,
    limit: number,
    options: RequestOptions,
  ): Promise<LastfmCandidateSource> {
    return this.enqueue(() => this.candidates({ tag }, limit, options));
  }

  getSimilarTracks(
    artist: string,
    title: string,
    limit: number,
    options: RequestOptions,
  ): Promise<LastfmCandidateSource> {
    return this.enqueue(() =>
      this.candidates({ artist, title }, limit, options),
    );
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queued.then(action);
    this.queued = operation.catch(() => {});
    return operation;
  }

  private async request(
    method:
      | "track.getTopTags"
      | "artist.getTopTags"
      | "tag.getTopTracks"
      | "track.getSimilar",
    parameters: Record<string, string>,
    options: RequestOptions,
  ) {
    const key = await this.getApiKey();
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({
      ...parameters,
      method,
      api_key: key,
      format: "json",
    }).toString();
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      options.budget.take();
      if (this.lastStarted !== undefined) {
        const wait = this.minInterval - (this.now() - this.lastStarted);
        if (wait > 0) await this.sleep(wait);
      }
      options.signal?.throwIfAborted();
      this.lastStarted = this.now();
      let response: Response;
      let body: unknown;
      try {
        response = await this.fetch(url.href, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        });
      } catch {
        options.signal?.throwIfAborted();
        if (
          attempt < this.maxRetries &&
          options.budget.used < options.budget.limit
        ) {
          await this.sleep(1_000 * 2 ** attempt);
          continue;
        }
        throw new LastfmApiError(undefined, undefined);
      }
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const apiError = z
        .object({ error: z.coerce.number().int() })
        .safeParse(body);
      const code = apiError.success ? apiError.data.error : undefined;
      const transient =
        response.status === 429 ||
        response.status >= 500 ||
        (code !== undefined && [8, 11, 16, 29].includes(code));
      if (
        transient &&
        attempt < this.maxRetries &&
        options.budget.used < options.budget.limit
      ) {
        await this.sleep(
          retryDelay(
            response.headers.get("Retry-After"),
            1_000 * 2 ** attempt,
            this.now(),
          ),
        );
        continue;
      }
      if (!response.ok || (code !== undefined && code !== 6))
        throw new LastfmApiError(response.status, code);
      return {
        body,
        notFound: code === 6,
        status: response.status,
        cacheTtlMs: cacheLifetime(response.headers, this.now()),
        redact: (value: string, replacement = "[redacted]") =>
          value.replaceAll(key, replacement),
      };
    }
  }

  private async lookup(
    level: TagLevel,
    artist: string,
    title: string | null,
    options: RequestOptions,
  ) {
    if (!artist.trim() || (level === "track" && !title?.trim()))
      throw new Error("Last.fm needs an artist and, for track tags, a title.");
    const response = await this.request(
      level === "track" ? "track.getTopTags" : "artist.getTopTags",
      {
        artist,
        ...(level === "track" ? { track: title ?? "" } : {}),
        autocorrect: "0",
      },
      options,
    );
    if (response.notFound)
      return {
        tags: [],
        sourceUrl: sourceUrl(level, artist, title ?? undefined),
        notFound: true,
        cacheTtlMs: response.cacheTtlMs,
      };
    const parsed = tagsSchema.safeParse(response.body);
    if (!parsed.success) throw new LastfmApiError(response.status, undefined);
    const raw = parsed.data.toptags.tag;
    const values = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? [raw]
        : [];
    const tags = new Map<string, LastfmTag>();
    for (const value of values) {
      const name = response.redact(value.name);
      const normalized = normalizeTag(name);
      if (!normalized || name.length > 200) continue;
      const number =
        value.count === undefined || value.count === ""
          ? null
          : Number(value.count);
      const count =
        number !== null && Number.isFinite(number) && number >= 0
          ? number
          : null;
      const previous = tags.get(normalized);
      if (!previous || (count ?? -1) > (previous.count ?? -1))
        tags.set(normalized, {
          name,
          normalized,
          count,
          url: tagUrl(
            value.url ? response.redact(value.url, "redacted") : undefined,
            name,
          ),
        });
    }
    return {
      tags: [...tags.values()].slice(0, 20),
      sourceUrl: sourceUrl(level, artist, title ?? undefined),
      notFound: false,
      cacheTtlMs: response.cacheTtlMs,
    };
  }

  private async candidates(
    input: { tag: string } | { artist: string; title: string },
    limit: number,
    options: RequestOptions,
  ): Promise<LastfmCandidateSource> {
    const bounded = Math.min(50, Math.max(1, Math.trunc(limit)));
    const tagged = "tag" in input;
    const response = tagged
      ? await this.request(
          "tag.getTopTracks",
          { tag: input.tag, limit: String(bounded) },
          options,
        )
      : await this.request(
          "track.getSimilar",
          {
            artist: input.artist,
            track: input.title,
            autocorrect: "0",
            limit: String(bounded),
          },
          options,
        );
    const url = tagged
      ? `https://www.last.fm/tag/${encodeURIComponent(input.tag)}`
      : sourceUrl("track", input.artist, input.title);
    if (response.notFound)
      return {
        candidates: [],
        source_url: url,
        cacheTtlMs: response.cacheTtlMs,
      };
    const root = z.record(z.string(), z.unknown()).safeParse(response.body);
    const page = z
      .object({ track: z.unknown().optional() })
      .safeParse(
        root.success
          ? root.data[tagged ? "tracks" : "similartracks"]
          : undefined,
      );
    if (!page.success) throw new LastfmApiError(response.status, undefined);
    const raw = page.data.track;
    if (
      raw !== undefined &&
      raw !== null &&
      raw !== "" &&
      !Array.isArray(raw) &&
      typeof raw !== "object"
    )
      throw new LastfmApiError(response.status, undefined);
    const values = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? [raw]
        : [];
    const schema = z.object({
      name: z.string(),
      artist: z.union([z.string(), z.object({ name: z.string() })]),
      url: z.string().optional(),
      match: z.union([z.string(), z.number()]).nullish(),
      "@attr": z
        .object({ rank: z.union([z.string(), z.number()]).optional() })
        .optional(),
    });
    const candidates: LastfmCandidate[] = [];
    for (const [index, value] of values.entries()) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) continue;
      const artist = response
        .redact(
          typeof parsed.data.artist === "string"
            ? parsed.data.artist
            : parsed.data.artist.name,
        )
        .trim();
      const title = response.redact(parsed.data.name).trim();
      if (!artist || !title || artist.length > 200 || title.length > 300)
        continue;
      const similarity =
        parsed.data.match === null ||
        parsed.data.match === undefined ||
        parsed.data.match === ""
          ? undefined
          : Number(parsed.data.match);
      const rank = Number(parsed.data["@attr"]?.rank);
      candidates.push({
        artist,
        title,
        source_url: safeLastfmUrl(
          parsed.data.url
            ? response.redact(parsed.data.url, "redacted")
            : undefined,
          sourceUrl("track", artist, title),
        ),
        rank: Number.isFinite(rank) && rank > 0 ? rank : index + 1,
        ...(similarity !== undefined &&
        Number.isFinite(similarity) &&
        similarity >= 0
          ? { similarity_score: similarity }
          : {}),
      });
      if (candidates.length === bounded) break;
    }
    if (values.length && !candidates.length)
      throw new LastfmApiError(response.status, undefined);
    return { candidates, source_url: url, cacheTtlMs: response.cacheTtlMs };
  }
}
