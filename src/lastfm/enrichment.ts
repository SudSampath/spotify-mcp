import { createHash, randomUUID } from "node:crypto";
import { LibraryCache } from "../library/cache.js";
import {
  LastfmClient,
  RequestBudget,
  RequestBudgetExceeded,
} from "./client.js";
import { type LastfmLookup, normalizeTag, type TagLevel } from "./types.js";

const POSITIVE_TTL = 30 * 24 * 60 * 60 * 1_000;
const EMPTY_TTL = 7 * 24 * 60 * 60 * 1_000;

export interface WholeLibraryInput {
  scope?: "all" | TagLevel | undefined;
  request_budget?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?:
    | ((progress: {
        phase: TagLevel;
        processed: number;
        total: number;
        requests: number;
        cache_hits: number;
      }) => Promise<void>)
    | undefined;
}
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
    else cache.deleteLastfmLookup(key);
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

  async enrichAll(input: WholeLibraryInput = {}) {
    const cache = await this.openCache();
    const owner = randomUUID();
    let acquired = false;
    try {
      if (!cache.state())
        return {
          status: "needs_sync" as const,
          message: "Run sync_library before tagging the whole library.",
          coverage: cache.lastfmCoverage(this.now()),
        };
      cache.acquireSync(owner);
      acquired = true;
      const budget = new RequestBudget(
        input.request_budget ?? Number.MAX_SAFE_INTEGER,
      );
      const scope = input.scope ?? "all";
      const artists = cache.enrichmentArtists();
      const tracks = cache.identityTracks();
      const counts = {
        artist: { processed: 0, total: scope === "track" ? 0 : artists.length },
        track: { processed: 0, total: scope === "artist" ? 0 : tracks.length },
      };
      const targets = [
        ...(scope === "track"
          ? []
          : artists.map((artist) => ({
              level: "artist" as const,
              id: artist.id,
              artist: artist.name,
              title: null,
            }))),
        ...(scope === "artist"
          ? []
          : tracks.map((track) => ({
              level: "track" as const,
              id: track.uri,
              artist: track.artists[0] ?? "",
              title: track.name,
            }))),
      ];
      let cacheHits = 0;
      let empty = 0;
      let uncacheable = 0;
      let exhausted = false;
      for (const target of targets) {
        input.signal?.throwIfAborted();
        if (!target.artist)
          throw new Error(
            "A cached track has no artist identity. Run sync_library before enrichment.",
          );
        try {
          const found = await this.lookup(
            cache,
            target.level,
            target.artist,
            target.title,
            budget,
            input.signal,
          );
          if (found.cacheHit) cacheHits++;
          if (!found.lookup.tags.length) empty++;
          if (found.lookup.expiresAt > this.now()) {
            if (target.level === "artist")
              cache.linkLastfmArtist(target.id, found.lookup.key);
            else cache.linkLastfmTrack(target.id, found.lookup.key);
          } else uncacheable++;
          counts[target.level].processed++;
          await input.onProgress?.({
            phase: target.level,
            ...counts[target.level],
            requests: budget.used,
            cache_hits: cacheHits,
          });
        } catch (error) {
          if (!(error instanceof RequestBudgetExceeded)) throw error;
          exhausted = true;
          break;
        }
      }
      return {
        status: exhausted
          ? ("budget_exhausted" as const)
          : uncacheable
            ? ("incomplete" as const)
            : ("complete" as const),
        phases: counts,
        requests_made: budget.used,
        cache_hits: cacheHits,
        empty_lookups: empty,
        uncacheable_lookups: uncacheable,
        storage_bytes: cache.lastfmStorageBytes(),
        coverage: cache.lastfmCoverage(this.now()),
        note: "Artist lookups precede track lookups. Every stored result, including confirmed empty lookups, is a durable checkpoint. Reruns refresh due entries and link fresh cache hits without HTTP. Provider restrictions may prevent retaining some results.",
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
