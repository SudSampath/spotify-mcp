import { createHash } from "node:crypto";
import { LibraryCache } from "../library/cache.js";
import {
  type CatalogItem,
  type CatalogService,
  chooseTrack,
  normalizedTitle,
  type TrackInput,
  trackIdentity,
} from "../spotify/catalog.js";
import {
  LastfmApiError,
  LastfmClient,
  RequestBudget,
  RequestBudgetExceeded,
} from "./client.js";
import { LastfmConfigError } from "./config.js";
import { type LastfmDiscoveryCache, normalizeTag } from "./types.js";

interface Evidence {
  kind: "cached_tag" | "lastfm_tag_listing" | "lastfm_similarity";
  source: string;
  source_url: string;
  tag?: string | undefined;
  level?: string | undefined;
  seed?: TrackInput | undefined;
  similarity_score?: number | undefined;
  count?: number | null | undefined;
  rank?: number | undefined;
  fetched_at: string;
  expires_at: string;
}
interface Suggested {
  track: CatalogItem;
  source: "library" | "catalog";
  confidence?: number | undefined;
  verifiedBy?: "spotify_library_cache" | "spotify_search" | undefined;
  evidence: Evidence[];
}
interface Candidate {
  input: TrackInput;
  evidence: Evidence[];
  rank: number;
}
type Source = { tag: string } | { seed: TrackInput };
export interface DiscoveryInput {
  tags: string[];
  seeds: TrackInput[];
  limit: number;
  tag_level: "any" | "track" | "artist";
  request_budget: number;
  resolve_limit: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => Promise<void>) | undefined;
}

export class DiscoveryService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly lastfm = new LastfmClient(),
    private readonly openCache: () => Promise<LibraryCache> = () =>
      LibraryCache.open(),
    private readonly now: () => number = Date.now,
  ) {}

  private async source(
    cache: LibraryCache,
    input: Source,
    budget: RequestBudget,
    signal?: AbortSignal,
  ) {
    const identity =
      "tag" in input
        ? ["tag", normalizeTag(input.tag)]
        : ["seed", trackIdentity(input.seed)];
    const key = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    const saved = cache.readLastfmDiscovery(key, this.now());
    if (saved) return { value: saved, cacheHit: true };
    const response =
      "tag" in input
        ? await this.lastfm.getTagTracks(input.tag, 50, { budget, signal })
        : await this.lastfm.getSimilarTracks(
            input.seed.artist,
            input.seed.title,
            50,
            { budget, signal },
          );
    const fetchedAt = this.now();
    const ttl = Math.min(
      response.candidates.length ? 86_400_000 : 21_600_000,
      response.cacheTtlMs ?? Number.POSITIVE_INFINITY,
    );
    const value: LastfmDiscoveryCache = {
      key,
      candidates: response.candidates,
      sourceUrl: response.source_url,
      fetchedAt,
      expiresAt: fetchedAt + ttl,
    };
    if (ttl > 0) cache.saveLastfmDiscovery(value);
    return { value, cacheHit: false };
  }

  async discover(input: DiscoveryInput) {
    const cache = await this.openCache();
    try {
      const tags = [
        ...new Map(input.tags.map((tag) => [normalizeTag(tag), tag])).values(),
      ];
      const seeds = [
        ...new Map(
          input.seeds.map((seed) => [trackIdentity(seed), seed]),
        ).values(),
      ];
      const state = cache.state();
      const warnings: string[] = state
        ? []
        : ["Run sync_library to enable library-first matching."];
      const library = new Map<string, Suggested>();
      if (state && tags.length) {
        const matching = cache.query(
          { tags, tag_level: input.tag_level, limit: input.limit, offset: 0 },
          this.now(),
        );
        for (const track of matching.tracks)
          library.set(track.uri, {
            source: "library",
            track: {
              type: "track",
              uri: track.uri,
              name: track.title,
              artists: track.artists.map((artist) => artist.name),
              album: track.album,
              year: track.year,
            },
            evidence: track.tags
              .filter(
                (tag) =>
                  (input.tag_level === "any" ||
                    tag.level === input.tag_level) &&
                  tags.some((wanted) =>
                    tag.normalized.includes(normalizeTag(wanted)),
                  ),
              )
              .map((tag) => ({
                kind: "cached_tag",
                source: tag.source,
                source_url: tag.source_url,
                tag: tag.name,
                level: tag.level,
                count: tag.count,
                fetched_at: tag.fetched_at,
                expires_at: tag.expires_at,
              })),
          });
      }
      const budget = new RequestBudget(input.request_budget);
      const sources: {
        source: Source;
        source_url: string;
        cache_hit: boolean;
        candidates: number;
        fetched_at: string;
        expires_at: string;
      }[] = [];
      const candidates = new Map<string, Candidate>();
      if (library.size < input.limit || seeds.length) {
        for (const source of [
          ...tags.map((tag): Source => ({ tag })),
          ...seeds.map((seed): Source => ({ seed })),
        ]) {
          input.signal?.throwIfAborted();
          try {
            const response = await this.source(
              cache,
              source,
              budget,
              input.signal,
            );
            sources.push({
              source,
              source_url: response.value.sourceUrl,
              cache_hit: response.cacheHit,
              candidates: response.value.candidates.length,
              fetched_at: new Date(response.value.fetchedAt).toISOString(),
              expires_at: new Date(response.value.expiresAt).toISOString(),
            });
            const sourceCandidates = new Set<string>();
            for (const value of response.value.candidates) {
              const key = trackIdentity(value);
              if (sourceCandidates.has(key)) continue;
              sourceCandidates.add(key);
              const candidate = candidates.get(key) ?? {
                input: { artist: value.artist, title: value.title },
                evidence: [],
                rank: value.rank,
              };
              candidate.rank = Math.min(candidate.rank, value.rank);
              candidate.evidence.push(
                "tag" in source
                  ? {
                      kind: "lastfm_tag_listing",
                      source: "Last.fm",
                      source_url: response.value.sourceUrl,
                      tag: source.tag,
                      level: "track",
                      rank: value.rank,
                      fetched_at: new Date(
                        response.value.fetchedAt,
                      ).toISOString(),
                      expires_at: new Date(
                        response.value.expiresAt,
                      ).toISOString(),
                    }
                  : {
                      kind: "lastfm_similarity",
                      source: "Last.fm",
                      source_url: value.source_url,
                      seed: source.seed,
                      similarity_score: value.similarity_score,
                      rank: value.rank,
                      fetched_at: new Date(
                        response.value.fetchedAt,
                      ).toISOString(),
                      expires_at: new Date(
                        response.value.expiresAt,
                      ).toISOString(),
                    },
              );
              candidates.set(key, candidate);
            }
            await input.onProgress?.(
              `${sources.length} Last.fm sources read; ${budget.used} requests`,
            );
          } catch (error) {
            if (
              error instanceof RequestBudgetExceeded ||
              error instanceof LastfmConfigError ||
              error instanceof LastfmApiError
            ) {
              warnings.push(error.message);
              break;
            }
            throw error;
          }
        }
      }
      const identities = new Map<string, CatalogItem[]>();
      for (const track of cache.identityTracks()) {
        const key = normalizedTitle(track.name);
        const group = identities.get(key) ?? [];
        group.push(track);
        identities.set(key, group);
      }
      const catalog: Candidate[] = [];
      const unresolved: {
        input: TrackInput;
        reason: string;
        closest?: unknown;
      }[] = [];
      const ranked = [...candidates.values()].sort(
        (a, b) => b.evidence.length - a.evidence.length || a.rank - b.rank,
      );
      for (const candidate of ranked) {
        const supported = tags.every((tag) =>
          candidate.evidence.some(
            (value) =>
              value.kind === "lastfm_tag_listing" &&
              normalizeTag(value.tag ?? "") === normalizeTag(tag),
          ),
        );
        const local = chooseTrack(
          candidate.input,
          identities.get(normalizedTitle(candidate.input.title)) ?? [],
        );
        const locallyTagged =
          local.track && tags.length
            ? cache.query(
                {
                  uri: local.track.uri,
                  tags,
                  tag_level: input.tag_level,
                  limit: 1,
                  offset: 0,
                },
                this.now(),
              ).tracks[0]
            : undefined;
        if (!supported && !locallyTagged) {
          if (unresolved.length < 50)
            unresolved.push({
              input: candidate.input,
              reason: "insufficient_tag_evidence",
            });
          continue;
        }
        if (local.status === "matched" && local.track) {
          const existing = library.get(local.track.uri);
          const localEvidence: Evidence[] = (locallyTagged?.tags ?? [])
            .filter(
              (tag) =>
                (input.tag_level === "any" || tag.level === input.tag_level) &&
                tags.some((wanted) =>
                  tag.normalized.includes(normalizeTag(wanted)),
                ),
            )
            .map((tag) => ({
              kind: "cached_tag",
              source: tag.source,
              source_url: tag.source_url,
              tag: tag.name,
              level: tag.level,
              count: tag.count,
              fetched_at: tag.fetched_at,
              expires_at: tag.expires_at,
            }));
          library.set(local.track.uri, {
            source: "library",
            track: local.track,
            evidence: [
              ...(existing?.evidence ?? localEvidence),
              ...candidate.evidence,
            ],
          });
        } else catalog.push(candidate);
      }
      const seedWeight = (value: Suggested) =>
        value.evidence.filter(
          (evidence) => evidence.kind === "lastfm_similarity",
        ).length;
      const chosen = [...library.values()]
        .sort((a, b) => seedWeight(b) - seedWeight(a))
        .slice(0, input.limit);
      const seenUris = new Set(chosen.map((value) => value.track.uri));
      let attempted = 0;
      for (const candidate of catalog) {
        if (chosen.length >= input.limit || attempted >= input.resolve_limit)
          break;
        input.signal?.throwIfAborted();
        attempted++;
        const result = await this.catalog.resolveOne(
          candidate.input,
          input.signal,
        );
        if (result.status === "matched" && result.track) {
          if (!seenUris.has(result.track.uri)) {
            seenUris.add(result.track.uri);
            chosen.push({
              source: cache.hasTrack(result.track.uri) ? "library" : "catalog",
              track: result.track,
              verifiedBy: "spotify_search",
              confidence: result.confidence,
              evidence: candidate.evidence,
            });
          } else {
            chosen
              .find((value) => value.track.uri === result.track?.uri)
              ?.evidence.push(...candidate.evidence);
          }
        } else if (unresolved.length < 50)
          unresolved.push({
            input: candidate.input,
            reason: result.reason ?? "not_found",
            ...(result.closest ? { closest: result.closest } : {}),
          });
        await input.onProgress?.(`${attempted} catalog candidates verified`);
      }
      if (attempted < catalog.length && chosen.length < input.limit)
        warnings.push(
          "The catalog verification limit was reached; additional candidates remain unverified.",
        );
      return {
        status:
          warnings.length || chosen.length < input.limit
            ? "partial"
            : "complete",
        results: [
          ...chosen.filter((value) => value.source === "library"),
          ...chosen.filter((value) => value.source === "catalog"),
        ].map((value) => ({
          ...value.track,
          source: value.source,
          ...(value.confidence === undefined
            ? {}
            : { confidence: value.confidence }),
          verified_by:
            value.verifiedBy ??
            (value.source === "library"
              ? "spotify_library_cache"
              : "spotify_search"),
          evidence: value.evidence,
        })),
        unresolved,
        requested_limit: input.limit,
        library_matches: chosen.filter((value) => value.source === "library")
          .length,
        catalog_matches: chosen.filter((value) => value.source === "catalog")
          .length,
        lastfm_requests: budget.used,
        catalog_candidates_verified: attempted,
        sources,
        warnings,
        coverage: {
          library_synced_at: state?.completedAt ?? null,
          ...cache.lastfmCoverage(this.now()),
        },
        note: "Community tag associations and similarity scores are qualitative evidence, not measured tempo or beats. Results are suggestions only; no playlist or account is changed.",
      };
    } finally {
      cache.close();
    }
  }
}
