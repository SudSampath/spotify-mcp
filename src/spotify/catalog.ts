import { z } from "zod";
import { SpotifyApiError, type SpotifyClient } from "./client.js";

export const SEARCH_TYPES = [
  "track",
  "artist",
  "album",
  "playlist",
  "show",
  "episode",
  "audiobook",
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export interface CatalogItem {
  type: SearchType;
  uri: string;
  name: string;
  artists: string[];
  album: string | null;
  year: number | null;
  is_playable?: boolean | undefined;
  is_local?: boolean | undefined;
}
export interface TrackInput {
  artist: string;
  title: string;
}
export interface Resolution {
  status: "matched" | "unresolved";
  confidence: number;
  track?: CatalogItem | undefined;
  reason?: string | undefined;
  closest?:
    | {
        name: string;
        artists: string[];
        album: string | null;
        year: number | null;
        confidence: number;
      }
    | undefined;
}

const entitySchema = z.object({
  name: z.string(),
  uri: z.string(),
  artists: z.array(z.object({ name: z.string() })).optional(),
  album: z
    .object({ name: z.string(), release_date: z.string().optional() })
    .optional(),
  release_date: z.string().optional(),
  is_playable: z.boolean().optional(),
  is_local: z.boolean().optional(),
});

export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function removeCredits(value: string): string {
  return value
    .replace(/\s*[([]\s*(?:feat(?:uring)?\.?|ft\.?|with)\s+[^)\]]*[)\]]/gi, "")
    .replace(/\s+(?:feat(?:uring)?\.?|ft\.?)\s+.*$/i, "")
    .replace(/\s+-\s+with\s+.*$/i, "");
}

export function normalizedTitle(value: string): string {
  return normalizeName(
    removeCredits(value).replace(
      /\s*(?:-\s*|[([]\s*)(?:(?:\d{4}\s+)?(?:digital\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|original\s+(?:mix|version))\s*[)\]]?\s*$/i,
      "",
    ),
  );
}

export function trackIdentity(input: TrackInput): string {
  return JSON.stringify([
    normalizeName(removeCredits(input.artist)).replace(/\s/g, ""),
    normalizedTitle(input.title),
  ]);
}

function distanceRatio(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j] ?? 0;
      previous[j] = Math.min(
        above + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return (
    1 - (previous[right.length] ?? 0) / Math.max(left.length, right.length)
  );
}

function artistNames(value: string): string[] {
  return [value, removeCredits(value), value.replace(/\s+with\s+.*$/i, "")].map(
    (name) => normalizeName(name).replace(/\s/g, ""),
  );
}

function score(input: TrackInput, track: CatalogItem) {
  const wantedArtists = artistNames(input.artist);
  const candidates = [...track.artists, track.artists.join(" & ")].flatMap(
    artistNames,
  );
  const artist = Math.max(
    0,
    ...wantedArtists.flatMap((wanted) =>
      candidates.map((actual) => distanceRatio(wanted, actual)),
    ),
  );
  const wantedTitle = normalizedTitle(input.title);
  const actualTitle = normalizedTitle(track.name);
  const title = distanceRatio(wantedTitle, actualTitle);
  const exact =
    wantedTitle === actualTitle &&
    wantedArtists.some(
      (wanted) => wanted !== "" && candidates.includes(wanted),
    );
  const playable = track.is_playable !== false && track.is_local !== true;
  const alternativeAlbum = /\b(live|remixes|remix|karaoke|tribute)\b/.test(
    normalizeName(track.album ?? ""),
  );
  const requestedVersion = /[-–—([].*\b(live|remix|karaoke|tribute)\b/i.test(
    input.title,
  );
  const confidence = Math.round((title * 0.7 + artist * 0.3) * 1_000) / 1_000;
  return {
    track,
    exact: exact && (!alternativeAlbum || requestedVersion),
    playable,
    confidence,
    penalty: Number(normalizeName(input.title) !== normalizeName(track.name)),
  };
}

export function chooseTrack(
  input: TrackInput,
  tracks: CatalogItem[],
): Resolution {
  const ranked = tracks
    .filter((track) => track.type === "track")
    .map((track) => score(input, track));
  ranked.sort(
    (a, b) =>
      Number(b.exact && b.playable) - Number(a.exact && a.playable) ||
      b.confidence - a.confidence ||
      a.penalty - b.penalty ||
      (a.track.year ?? 9999) - (b.track.year ?? 9999),
  );
  const best = ranked[0];
  if (best?.exact && best.playable)
    return {
      status: "matched",
      confidence: best.penalty ? 0.98 : 1,
      track: best.track,
    };
  return {
    status: "unresolved",
    confidence: best?.confidence ?? 0,
    reason:
      best?.exact && !best.playable
        ? "not_playable"
        : best
          ? "identity_or_version_mismatch"
          : "not_found",
    ...(best
      ? {
          closest: {
            name: best.track.name,
            artists: best.track.artists,
            album: best.track.album,
            year: best.track.year,
            confidence: best.confidence,
          },
        }
      : {}),
  };
}

interface ResolveOptions {
  signal?: AbortSignal | undefined;
  onProgress?:
    | ((completed: number, total: number) => Promise<void>)
    | undefined;
}

export class CatalogService {
  constructor(private readonly client: SpotifyClient) {}

  async search(
    query: string,
    type: SearchType = "track",
    limit = 5,
    signal?: AbortSignal,
  ) {
    const bounded = Math.min(10, Math.max(1, Math.trunc(limit)));
    const parameters = new URLSearchParams({
      q: query,
      type,
      limit: String(bounded),
    });
    const raw = z
      .record(z.string(), z.unknown())
      .safeParse(
        await this.client.request(`/search?${parameters}`, { signal }),
      );
    const collection = z
      .object({
        items: z.array(z.unknown()),
        total: z.number().int().nonnegative().optional(),
      })
      .safeParse(raw.success ? raw.data[`${type}s`] : undefined);
    if (!collection.success)
      throw new Error("Spotify returned an invalid search response.");
    const results: CatalogItem[] = [];
    for (const item of collection.data.items) {
      const parsed = entitySchema.safeParse(item);
      if (
        !parsed.success ||
        !new RegExp(`^spotify:${type}:[A-Za-z0-9]{22}$`).test(parsed.data.uri)
      )
        continue;
      const value = parsed.data;
      if (type === "track" && (!value.artists?.length || !value.album))
        continue;
      const year = (value.album?.release_date ?? value.release_date)?.match(
        /^\d{4}/,
      )?.[0];
      results.push({
        type,
        uri: value.uri,
        name: value.name,
        artists: value.artists?.map((artist) => artist.name) ?? [],
        album: value.album?.name ?? null,
        year: year ? Number(year) : null,
        ...(value.is_playable === undefined
          ? {}
          : { is_playable: value.is_playable }),
        ...(value.is_local === undefined ? {} : { is_local: value.is_local }),
      });
      if (results.length === bounded) break;
    }
    return {
      type,
      limit: bounded,
      total: collection.data.total ?? null,
      results,
    };
  }

  async resolveOne(
    input: TrackInput,
    signal?: AbortSignal,
  ): Promise<Resolution> {
    const quoted = (value: string) =>
      value
        .replace(/["\\\r\n]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    let filtered: CatalogItem[] = [];
    try {
      filtered = (
        await this.search(
          `track:"${quoted(input.title)}" artist:"${quoted(input.artist)}"`,
          "track",
          10,
          signal,
        )
      ).results;
    } catch (error) {
      if (!(error instanceof SpotifyApiError && error.status === 400))
        throw error;
    }
    const match = chooseTrack(input, filtered);
    if (match.status === "matched") return match;
    const plain = (
      await this.search(`${input.title} ${input.artist}`, "track", 10, signal)
    ).results;
    const unique = new Map(
      [...filtered, ...plain].map((track) => [track.uri, track]),
    );
    return chooseTrack(input, [...unique.values()]);
  }

  async resolveTracks(inputs: TrackInput[], options: ResolveOptions = {}) {
    const matched: {
      index: number;
      input: TrackInput;
      uri: string;
      confidence: number;
      track: CatalogItem;
    }[] = [];
    const unresolved: {
      index: number;
      input: TrackInput;
      reason: string;
      closest?: Resolution["closest"];
    }[] = [];
    const memo = new Map<string, Resolution>();
    for (const [index, input] of inputs.entries()) {
      options.signal?.throwIfAborted();
      const key = trackIdentity(input);
      const result =
        memo.get(key) ?? (await this.resolveOne(input, options.signal));
      memo.set(key, result);
      if (result.status === "matched" && result.track)
        matched.push({
          index,
          input,
          uri: result.track.uri,
          confidence: result.confidence,
          track: result.track,
        });
      else
        unresolved.push({
          index,
          input,
          reason: result.reason ?? "not_found",
          ...(result.closest ? { closest: result.closest } : {}),
        });
      await options.onProgress?.(index + 1, inputs.length);
    }
    return { matched, unresolved };
  }
}
