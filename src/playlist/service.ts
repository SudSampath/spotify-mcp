import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LOGIN_REQUIRED_MESSAGE,
  LoginRequiredError,
  SpotifyConfigError,
} from "../auth/errors.js";
import { LibraryCache } from "../library/cache.js";
import { SpotifyApiError, type SpotifyClient } from "../spotify/client.js";
import type {
  CommitResult,
  PlaylistPreview,
  PreviewStore,
  PreviewTrack,
  StoredPreview,
} from "./store.js";

const idPattern = /^[A-Za-z0-9]{22}$/;
const uriPattern = /^spotify:track:([A-Za-z0-9]{22})$/;
const ownerSchema = z.object({ id: z.string().min(1) });
const countSchema = z.object({ total: z.number().int().nonnegative() });
const playlistSchema = z.object({
  id: z.string().regex(idPattern),
  name: z.string(),
  owner: ownerSchema,
  collaborative: z.boolean().default(false),
  public: z.boolean().nullable().optional(),
  description: z.string().nullable().optional(),
  items: countSchema.optional(),
  tracks: countSchema.optional(),
});
const trackSchema = z.object({
  uri: z.string(),
  name: z.string(),
  artists: z.array(z.object({ name: z.string() })).min(1),
  is_local: z.boolean().optional(),
  is_playable: z.boolean().optional(),
});
const playlistUrl = (id: string) => `https://open.spotify.com/playlist/${id}`;
type Options = {
  signal?: AbortSignal | undefined;
  onProgress?: ((added: number, total: number) => Promise<void>) | undefined;
};
type PreviewInput = {
  name?: string;
  description?: string;
  public?: boolean;
  playlist_id?: string;
  uris: string[];
};

function safeError(error: unknown): string {
  if (
    error instanceof LoginRequiredError ||
    error instanceof SpotifyConfigError
  )
    return LOGIN_REQUIRED_MESSAGE;
  if (error instanceof SpotifyApiError)
    return `Spotify rejected the request (HTTP ${error.status}).`;
  return "Spotify did not return a confirmed response. Check your account before preparing another preview.";
}

function processAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class PlaylistService {
  constructor(
    private readonly client: SpotifyClient,
    private readonly openCache: () => Promise<LibraryCache> = () =>
      LibraryCache.open(),
    private readonly now: () => number = Date.now,
  ) {}

  private async account(signal?: AbortSignal): Promise<string> {
    return ownerSchema.parse(await this.client.request("/me", { signal })).id;
  }

  private async editable(id: string, account: string, signal?: AbortSignal) {
    const playlist = playlistSchema.parse(
      await this.client.request(`/playlists/${id}`, { signal }),
    );
    if (playlist.id !== id)
      throw new Error("Spotify returned a different playlist identity.");
    if (playlist.owner.id !== account && !playlist.collaborative)
      throw new Error(
        "This playlist cannot be edited: you do not own it and it is not collaborative.",
      );
    if (playlist.owner.id !== account) {
      let next: string | null = "/me/playlists?limit=50";
      const visited = new Set<string>();
      let listed = false;
      while (next && visited.size < 100) {
        if (visited.has(next))
          throw new Error("Spotify returned a repeated playlist page.");
        visited.add(next);
        const page: { items: { id: string }[]; next: string | null } = z
          .object({
            items: z.array(z.object({ id: z.string() })),
            next: z.string().nullable(),
          })
          .parse(await this.client.request(next, { signal }));
        if (page.items.some((value) => value.id === id)) {
          listed = true;
          break;
        }
        next = page.next;
      }
      if (!listed)
        throw new Error(
          "This collaborative playlist is not in your current user's playlists; edit access cannot be verified.",
        );
    }
    return playlist;
  }

  async list(limit = 20, offset = 0, signal?: AbortSignal) {
    const account = await this.account(signal);
    const page = z
      .object({
        items: z.array(z.unknown()),
        total: z.number().int().nonnegative(),
        next: z.string().nullable(),
      })
      .parse(
        await this.client.request(
          `/me/playlists?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`,
          { signal },
        ),
      );
    const playlists = page.items.flatMap((value) => {
      const parsed = playlistSchema.safeParse(value);
      if (!parsed.success) return [];
      const item = parsed.data;
      return [
        {
          id: item.id,
          name: item.name,
          track_count: item.items?.total ?? item.tracks?.total ?? null,
          owned: item.owner.id === account,
          collaborative: item.collaborative,
          public: item.public ?? null,
          url: playlistUrl(item.id),
        },
      ];
    });
    return {
      playlists,
      total: page.total,
      limit,
      offset,
      next_offset: page.next ? offset + page.items.length : null,
      skipped: page.items.length - playlists.length,
    };
  }

  async preview(input: PreviewInput, options: Options = {}) {
    const account = await this.account(options.signal);
    const target = input.playlist_id
      ? await this.editable(input.playlist_id, account, options.signal)
      : null;
    const cache = await this.openCache();
    try {
      const identities = new Map(
        cache.identityTracks().map((track) => [track.uri, track]),
      );
      const tracks: PreviewTrack[] = [];
      const invalid: PlaylistPreview["invalid"] = [];
      const duplicates: PlaylistPreview["duplicates"] = [];
      const seen = new Map<string, number>();
      for (const [index, original] of input.uris.entries()) {
        options.signal?.throwIfAborted();
        const uri = original.trim();
        const match = uriPattern.exec(uri);
        if (!match) {
          invalid.push({ index, uri: original, reason: "invalid_track_uri" });
          continue;
        }
        const previous = seen.get(uri);
        if (previous !== undefined) {
          duplicates.push({ index, uri, first_index: previous });
          continue;
        }
        seen.set(uri, index);
        const local = identities.get(uri);
        if (local)
          tracks.push({
            uri,
            name: local.name,
            artists: local.artists,
            source: "library",
          });
        else {
          try {
            const parsed = trackSchema.safeParse(
              await this.client.request(`/tracks/${match[1]}`, {
                signal: options.signal,
              }),
            );
            if (
              !parsed.success ||
              parsed.data.uri !== uri ||
              parsed.data.is_local ||
              parsed.data.is_playable === false
            ) {
              invalid.push({
                index,
                uri,
                reason: "unavailable_or_unverified_track",
              });
              continue;
            }
            tracks.push({
              uri,
              name: parsed.data.name,
              artists: parsed.data.artists.map((artist) => artist.name),
              source: "catalog",
            });
          } catch (error) {
            if (!(error instanceof SpotifyApiError && error.status === 404))
              throw error;
            invalid.push({ index, uri, reason: "track_not_found" });
          }
        }
        await options.onProgress?.(index + 1, input.uris.length);
      }
      const now = this.now();
      const preview: PlaylistPreview = {
        preview_id: randomUUID(),
        action: target ? "add" : "create",
        account_id: account,
        name: target?.name ?? input.name ?? "",
        description: target?.description ?? input.description ?? "",
        public: target ? target.public === true : (input.public ?? false),
        playlist_id: target?.id ?? null,
        playlist_url: target ? playlistUrl(target.id) : null,
        tracks,
        duplicates,
        invalid,
        created_at: now,
        expires_at: now + 30 * 60 * 1000,
        library_synced_at: cache.state()?.completedAt ?? null,
      };
      cache.playlistPreviews().save(preview);
      const {
        account_id: _account,
        created_at,
        expires_at,
        ...display
      } = preview;
      return {
        status: "preview" as const,
        ...display,
        created_at: new Date(created_at).toISOString(),
        expires_at: new Date(expires_at).toISOString(),
        track_count: tracks.length,
        requires_confirmation: true,
        warnings: cache.state()
          ? []
          : [
              "The library has not been synced; membership labels may be incomplete.",
            ],
        message:
          "No Spotify changes were made. Show this exact preview and wait for explicit user approval before calling commit_playlist. The token is single-use and expires in 30 minutes. Existing playlist items are preserved; deduplication applies within this request.",
      };
    } finally {
      cache.close();
    }
  }

  private previous(stored: StoredPreview, store: PreviewStore) {
    const result = stored.result;
    if (stored.state === "committing" && result && !processAlive(stored.pid)) {
      const uncertain: CommitResult = {
        ...result,
        status: "uncertain",
        uncertain_uris: [...result.not_attempted_uris],
        not_attempted_uris: [],
        message:
          "The committing process stopped. Remote state may differ from the last checkpoint. Check the playlist manually; this preview cannot be retried.",
      };
      store.progress(stored.preview.preview_id, uncertain, true);
      return { ...uncertain, replay: true };
    }
    return {
      ...result,
      status:
        result?.status === "committed"
          ? "already_committed"
          : (result?.status ?? "in_progress"),
      replay: true,
      message:
        result?.status === "committed"
          ? "This preview was already committed. No additional Spotify writes were made."
          : "This preview has already been claimed and cannot be retried. Check the existing result or playlist before preparing a new preview.",
    };
  }

  async commit(id: string, options: Options = {}) {
    const cache = await this.openCache();
    try {
      const store = cache.playlistPreviews();
      const stored = store.get(id);
      if (!stored)
        return {
          status: "unknown_preview",
          message:
            "Preview not found. Prepare a new preview and obtain approval.",
        };
      if (stored.state !== "pending") return this.previous(stored, store);
      const preview = stored.preview;
      if (preview.expires_at <= this.now())
        return {
          status: "expired",
          message:
            "This preview expired. Prepare a fresh preview and obtain approval before writing.",
        };
      if (!preview.tracks.length)
        return {
          status: "empty_preview",
          message:
            "There are no valid tracks to commit. No Spotify changes were made.",
        };
      const account = await this.account(options.signal);
      if (account !== preview.account_id)
        return {
          status: "account_mismatch",
          message:
            "Spotify account changed since the preview. Reconnect the original account or prepare a new preview and obtain approval.",
        };
      if (preview.playlist_id)
        await this.editable(preview.playlist_id, account, options.signal);
      const uris = preview.tracks.map((track) => track.uri);
      let result: CommitResult = {
        status: "in_progress",
        preview_id: id,
        playlist_id: preview.playlist_id,
        playlist_url: preview.playlist_url,
        added_count: 0,
        added_uris: [],
        failed_uris: [],
        uncertain_uris: [],
        not_attempted_uris: uris,
        message: "Commit in progress. Do not retry this preview.",
      };
      if (!store.claim(id, this.now(), result)) {
        const current = store.get(id);
        return current?.state !== "pending" && current
          ? this.previous(current, store)
          : {
              status: "expired",
              message:
                "The preview expired before it could be claimed. Prepare a fresh preview.",
            };
      }
      let phase: "create" | "add" =
        preview.action === "create" ? "create" : "add";
      let batch: string[] = [];
      let dispatched = false;
      try {
        if (preview.action === "create") {
          options.signal?.throwIfAborted();
          dispatched = true;
          const created = z.object({ id: z.string().regex(idPattern) }).parse(
            await this.client.request("/me/playlists", {
              method: "POST",
              body: {
                name: preview.name,
                description: preview.description,
                public: preview.public,
              },
              signal: options.signal,
            }),
          );
          result = {
            ...result,
            playlist_id: created.id,
            playlist_url: playlistUrl(created.id),
          };
          dispatched = false;
          store.progress(id, result);
        }
        phase = "add";
        for (let offset = 0; offset < uris.length; offset += 100) {
          batch = uris.slice(offset, offset + 100);
          options.signal?.throwIfAborted();
          dispatched = true;
          await this.client.request(`/playlists/${result.playlist_id}/items`, {
            method: "POST",
            body: { uris: batch },
            signal: options.signal,
          });
          dispatched = false;
          result = {
            ...result,
            added_count: offset + batch.length,
            added_uris: uris.slice(0, offset + batch.length),
            not_attempted_uris: uris.slice(offset + batch.length),
          };
          store.progress(id, result);
          await options
            .onProgress?.(result.added_count, uris.length)
            .catch(() => {});
        }
        result = {
          ...result,
          status: "committed",
          message:
            "The approved playlist changes were committed. This preview is now consumed.",
        };
      } catch (error) {
        const rejected =
          (error instanceof SpotifyApiError && error.status < 500) ||
          error instanceof LoginRequiredError ||
          error instanceof SpotifyConfigError;
        const uncertain = dispatched && !rejected;
        const remaining = uris.slice(result.added_count);
        result = {
          ...result,
          status: uncertain
            ? "uncertain"
            : result.added_count
              ? "partial_failure"
              : "failed",
          failed_uris: !uncertain && dispatched && phase === "add" ? batch : [],
          uncertain_uris: uncertain && phase === "add" ? batch : [],
          not_attempted_uris:
            dispatched && phase === "add"
              ? remaining.slice(batch.length)
              : remaining,
          message: `${safeError(error)} ${uncertain ? "The last write may have been applied." : "No further batches were sent."} This preview is consumed; do not retry it.`,
        };
      }
      store.progress(id, result, true);
      return result;
    } finally {
      cache.close();
    }
  }
}
