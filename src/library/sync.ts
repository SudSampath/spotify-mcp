import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SpotifyClient } from "../spotify/client.js";
import {
  type CachedTrack,
  LibraryCache,
  type LibraryFilters,
} from "./cache.js";

const spotifyId = z.string().regex(/^[A-Za-z0-9]{22}$/);
const artistIdentity = z.object({ id: spotifyId, name: z.string() });
const savedTrack = z.object({
  id: spotifyId,
  uri: z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/),
  name: z.string(),
  artists: z.array(artistIdentity).min(1),
  album: z.object({ name: z.string(), release_date: z.string().optional() }),
});
const pageSchema = z.object({
  items: z.array(
    z.object({
      added_at: z.iso.datetime({ offset: true }),
      track: z.unknown(),
    }),
  ),
  next: z.string().nullable(),
});
const artistSchema = artistIdentity.extend({
  genres: z.array(z.string()).optional(),
});

export interface SyncOptions {
  full?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?:
    | ((counts: { tracks: number; artists: number }) => Promise<void>)
    | undefined;
}

export class LibraryService {
  constructor(
    private readonly client: SpotifyClient,
    private readonly openCache: () => Promise<LibraryCache> = () =>
      LibraryCache.open(),
  ) {}

  async sync(options: SyncOptions = {}) {
    const cache = await this.openCache();
    const owner = randomUUID();
    let acquired = false;
    try {
      cache.acquireSync(owner);
      acquired = true;
      const previous = cache.state();
      const full = options.full === true || previous === null;
      const fullRun = full ? owner : null;
      const boundary = full ? null : (previous?.latestAddedAt ?? null);
      let latest = full ? null : boundary;
      let next: string | null = "/me/tracks?limit=50";
      const visited = new Set<string>();
      const seen = new Set<string>();
      let tracksSynced = 0;
      let tracksAdded = 0;
      let artistsFetched = 0;
      let artistRequests = 0;
      let skipped = 0;
      const progress = () =>
        options.onProgress?.({ tracks: tracksSynced, artists: artistsFetched });
      while (next !== null) {
        options.signal?.throwIfAborted();
        if (visited.has(next))
          throw new Error("Spotify library pagination repeated a page.");
        visited.add(next);
        const page = pageSchema.safeParse(
          await this.client.request(next, { signal: options.signal }),
        );
        if (!page.success)
          throw new Error("Spotify returned an invalid saved-tracks page.");
        const batch: CachedTrack[] = [];
        let reachedBoundary = false;
        for (const item of page.data.items) {
          const addedAt = new Date(item.added_at).toISOString();
          if (boundary && addedAt < boundary) {
            reachedBoundary = true;
            break;
          }
          if (latest === null || addedAt > latest) latest = addedAt;
          if (
            item.track === null ||
            (typeof item.track === "object" &&
              item.track !== null &&
              "is_local" in item.track &&
              item.track.is_local === true)
          ) {
            skipped++;
            continue;
          }
          const parsed = savedTrack.safeParse(item.track);
          if (!parsed.success)
            throw new Error(
              "Spotify returned invalid saved-track metadata; the sync checkpoint was not advanced.",
            );
          const track = parsed.data;
          if (seen.has(track.uri)) continue;
          seen.add(track.uri);
          // Scan all equal timestamps so a newly liked URI at the boundary is not missed.
          if (boundary === addedAt && cache.hasTrack(track.uri)) continue;
          const artists = [
            ...new Map(
              track.artists.map((artist) => [artist.id, artist]),
            ).values(),
          ];
          for (const artist of artists) {
            options.signal?.throwIfAborted();
            if (cache.hasArtist(artist.id)) continue;
            if (cache.skipGenreLookups()) {
              cache.saveArtist({ ...artist, genres: [] });
            } else {
              const response = artistSchema.safeParse(
                await this.client.request(`/artists/${artist.id}`, {
                  signal: options.signal,
                }),
              );
              artistRequests++;
              if (!response.success || response.data.id !== artist.id)
                throw new Error("Spotify returned invalid artist metadata.");
              cache.recordGenreResponse(response.data.genres !== undefined);
              cache.saveArtist({
                ...response.data,
                genres: response.data.genres ?? [],
              });
            }
            artistsFetched++;
            await progress();
          }
          const year = track.album.release_date?.match(/^\d{4}/)?.[0];
          batch.push({
            uri: track.uri,
            id: track.id,
            title: track.name,
            album: track.album.name,
            year: year ? Number(year) : null,
            addedAt,
            artists,
          });
        }
        options.signal?.throwIfAborted();
        tracksAdded += cache.saveTracks(batch, fullRun);
        tracksSynced += batch.length;
        await progress();
        next = reachedBoundary ? null : page.data.next;
      }
      options.signal?.throwIfAborted();
      const completedAt = new Date().toISOString();
      const removed = cache.finishSync(completedAt, latest, fullRun);
      const coverage = cache.genreCoverage();
      return {
        full,
        tracks_synced: tracksSynced,
        tracks_added: tracksAdded,
        artists_cached: artistsFetched,
        artist_requests: artistRequests,
        tracks_removed: removed,
        skipped_tracks: skipped,
        total_tracks: cache.count(),
        completed_at: completedAt,
        genre_coverage: coverage,
        ...(coverage.spotify_genres_omitted
          ? {
              warning:
                "Spotify omitted genres in sampled artist responses. Further artist lookups were skipped; genre filtering has incomplete coverage until tag enrichment is available.",
            }
          : {}),
      };
    } finally {
      if (acquired) cache.releaseSync(owner);
      cache.close();
    }
  }

  async getLibrary(filters: LibraryFilters) {
    const cache = await this.openCache();
    try {
      const state = cache.state();
      if (!state)
        return {
          status: "needs_sync" as const,
          message: "Run sync_library first to cache your Liked Songs.",
        };
      return {
        status: "ready" as const,
        last_synced_at: state.completedAt,
        genre_coverage: cache.genreCoverage(),
        tag_coverage: cache.lastfmCoverage(),
        ...cache.query(filters),
      };
    } finally {
      cache.close();
    }
  }
}
