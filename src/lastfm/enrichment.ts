import { createHash, randomUUID } from "node:crypto";
import { LibraryCache } from "../library/cache.js";
import {
  LastfmClient,
  RequestBudget,
  RequestBudgetExceeded,
} from "./client.js";
import { type LastfmLookup, normalizeTag, type TagLevel } from "./types.js";

const POSITIVE_TTL = 24 * 60 * 60 * 1_000;
const EMPTY_TTL = 6 * 60 * 60 * 1_000;
export interface EnrichInput {
  scope: TagLevel;
  limit: number;
  offset: number;
  request_budget: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => Promise<void>) | undefined;
}
export interface LookupInput {
  uri?: string | undefined;
  artist?: string | undefined;
  title?: string | undefined;
  include_artist_fallback: boolean;
  request_budget: number;
  signal?: AbortSignal | undefined;
}

export function lastfmCacheKey(
  level: TagLevel,
  artist: string,
  title: string | null,
): string {
  return `lastfm:${level}:${createHash("sha256")
    .update(
      JSON.stringify([
        level,
        normalizeTag(artist),
        title === null ? null : normalizeTag(title),
      ]),
    )
    .digest("hex")}`;
}

function view(value: { lookup: LastfmLookup; cacheHit: boolean }) {
  const lookup = value.lookup;
  return {
    source: "Last.fm",
    level: lookup.level,
    artist: lookup.artist,
    title: lookup.title,
    status: lookup.notFound
      ? "not_found"
      : lookup.tags.length
        ? "tagged"
        : "empty",
    tags: lookup.tags,
    source_url: lookup.sourceUrl,
    fetched_at: new Date(lookup.fetchedAt).toISOString(),
    expires_at: new Date(lookup.expiresAt).toISOString(),
    cache_hit: value.cacheHit,
    cache_stored: lookup.expiresAt > lookup.fetchedAt,
  };
}

export class LastfmEnrichment {
  constructor(
    private readonly client = new LastfmClient(),
    private readonly openCache: () => Promise<LibraryCache> = () =>
      LibraryCache.open(),
    private readonly now: () => number = Date.now,
  ) {}

  private async lookup(
    cache: LibraryCache,
    level: TagLevel,
    artist: string,
    title: string | null,
    budget: RequestBudget,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const key = lastfmCacheKey(level, artist, title);
    const saved = cache.readLastfmLookup(key, this.now());
    if (saved) return { lookup: saved, cacheHit: true };
    const response = await this.client.getTopTags(level, artist, title, {
      budget,
      signal,
    });
    const fetchedAt = this.now();
    const ttl = Math.min(
      response.tags.length ? POSITIVE_TTL : EMPTY_TTL,
      response.cacheTtlMs ?? Number.POSITIVE_INFINITY,
    );
    const lookup: LastfmLookup = {
      key,
      level,
      artist,
      title,
      ...response,
      fetchedAt,
      expiresAt: fetchedAt + ttl,
    };
    if (ttl > 0) cache.saveLastfmLookup(lookup);
    return { lookup, cacheHit: false };
  }

  async getTrackTags(input: LookupInput) {
    const cache = await this.openCache();
    const owner = randomUUID();
    let acquired = false;
    try {
      cache.acquireSync(owner);
      acquired = true;
      const track = input.uri
        ? cache.query({ uri: input.uri, limit: 1, offset: 0 }, this.now())
            .tracks[0]
        : undefined;
      if (input.uri && !track)
        throw new Error(
          "That URI is not in the local library. Run sync_library or provide artist and title.",
        );
      const artist = track?.artists[0]?.name ?? input.artist;
      const title = track?.title ?? input.title;
      if (!artist || !title)
        throw new Error("Provide a cached track URI or an artist and title.");
      const budget = new RequestBudget(input.request_budget);
      const result = await this.lookup(
        cache,
        "track",
        artist,
        title,
        budget,
        input.signal,
      );
      if (track && result.lookup.expiresAt > this.now())
        cache.linkLastfmTrack(track.uri, result.lookup.key);
      let fallback: ReturnType<typeof view> | null = null;
      let exhausted = false;
      if (input.include_artist_fallback && result.lookup.tags.length === 0) {
        try {
          const found = await this.lookup(
            cache,
            "artist",
            artist,
            null,
            budget,
            input.signal,
          );
          fallback = view(found);
          const primary = track?.artists[0];
          if (primary && found.lookup.expiresAt > this.now())
            cache.linkLastfmArtist(primary.id, found.lookup.key);
        } catch (error) {
          if (error instanceof RequestBudgetExceeded) exhausted = true;
          else throw error;
        }
      }
      return {
        ...(track ? { uri: track.uri } : {}),
        track: view(result),
        artist_fallback: fallback,
        requests_made: budget.used,
        budget_exhausted: exhausted,
        note: "Last.fm community tags are qualitative hints. Artist tags describe the artist; neither source measures BPM or beats.",
      };
    } finally {
      if (acquired) cache.releaseSync(owner);
      cache.close();
    }
  }

  async enrichLibrary(input: EnrichInput) {
    const cache = await this.openCache();
    const owner = randomUUID();
    let acquired = false;
    try {
      if (!cache.state())
        return {
          status: "needs_sync",
          message: "Run sync_library before enriching your library.",
        };
      cache.acquireSync(owner);
      acquired = true;
      const selected = cache.query(
        { limit: input.limit, offset: input.offset },
        this.now(),
      );
      const budget = new RequestBudget(input.request_budget);
      let processed = 0;
      let cached = 0;
      let lookups = 0;
      let empty = 0;
      let uncached = 0;
      let exhausted = false;
      try {
        for (const track of selected.tracks) {
          input.signal?.throwIfAborted();
          const targets =
            input.scope === "track" ? track.artists.slice(0, 1) : track.artists;
          for (const artist of targets) {
            const result = await this.lookup(
              cache,
              input.scope,
              artist.name,
              input.scope === "track" ? track.title : null,
              budget,
              input.signal,
            );
            if (result.cacheHit) cached++;
            else lookups++;
            if (!result.lookup.tags.length) empty++;
            if (result.lookup.expiresAt <= this.now()) {
              uncached++;
              continue;
            }
            if (input.scope === "track")
              cache.linkLastfmTrack(track.uri, result.lookup.key);
            else cache.linkLastfmArtist(artist.id, result.lookup.key);
          }
          processed++;
          await input.onProgress?.(
            `${processed} selected tracks processed; ${budget.used} Last.fm requests`,
          );
        }
      } catch (error) {
        if (error instanceof RequestBudgetExceeded) exhausted = true;
        else throw error;
      }
      const nextOffset = input.offset + processed;
      return {
        status: exhausted ? "budget_exhausted" : "complete",
        scope: input.scope,
        selected_tracks: selected.tracks.length,
        processed_tracks: processed,
        new_lookups: lookups,
        cache_hits: cached,
        empty_lookups: empty,
        uncacheable_lookups: uncached,
        requests_made: budget.used,
        request_budget: input.request_budget,
        next_offset: nextOffset < selected.total ? nextOffset : null,
        coverage: cache.lastfmCoverage(this.now()),
        note: "Only the requested batch was processed. Last.fm community tags retain track/artist provenance and do not measure tempo or beats.",
      };
    } finally {
      if (acquired) cache.releaseSync(owner);
      cache.close();
    }
  }
}
