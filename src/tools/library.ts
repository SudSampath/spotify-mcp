import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { normalizeTag } from "../lastfm/types.js";
import type { LibraryCache, LibraryTrack } from "../library/cache.js";
import { LibraryService } from "../library/sync.js";
import type { SpotifyClient } from "../spotify/client.js";
import { runSpotifyTool } from "../spotify/session.js";

const textFilter = z.string().trim().min(1).max(200).optional();
const addedAfter = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value).toISOString())
  .optional();

function short(value: string, length: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function libraryLine(
  track: LibraryTrack,
  genre?: string,
  tag?: string,
): string {
  const genres = genre
    ? [
        ...track.genres.filter((value) =>
          value.toLowerCase().includes(genre.toLowerCase()),
        ),
        ...track.genres.filter(
          (value) => !value.toLowerCase().includes(genre.toLowerCase()),
        ),
      ]
    : track.genres;
  const tags = tag
    ? track.tags.filter((value) => value.normalized.includes(normalizeTag(tag)))
    : track.tags;
  const labels = tags
    .slice(0, 2)
    .map((value) => `Last.fm ${value.level}: ${short(value.name, 20)}`)
    .join(", ");
  return `${short(track.artists.map((artist) => artist.name).join(", "), 32)} – ${short(track.title, 48)} – ${track.year ?? "?"} – ${short(genres.slice(0, 2).join(", "), 32) || "-"}${labels ? ` – ${labels}` : ""} – ${track.uri}`;
}

export function registerLibraryTools(
  server: McpServer,
  client: SpotifyClient,
  openCache?: () => Promise<LibraryCache>,
): void {
  const library = new LibraryService(client, openCache);
  server.registerTool(
    "sync_library",
    {
      description:
        "Cache Liked Songs and artist genres in local SQLite. Reads Spotify without changing your account. Incremental by default; full re-reads all saved tracks and removes unliked tracks from the local cache. Initial sync may take several minutes.",
      inputSchema: z.strictObject({ full: z.boolean().optional() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    (input, context) =>
      runSpotifyTool(async () => {
        const token = context.mcpReq._meta?.progressToken;
        let progress = 0;
        const data = await library.sync({
          full: input.full,
          signal: context.mcpReq.signal,
          onProgress: async (counts) => {
            if (typeof token === "string" || typeof token === "number") {
              await context.mcpReq.notify({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: ++progress,
                  message: `${counts.tracks} tracks and ${counts.artists} artists cached`,
                },
              });
            }
          },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }),
  );
  server.registerTool(
    "get_library",
    {
      description:
        "Read the local Liked Songs cache. Genre (Spotify only), artist, Last.fm tag, release year, and added_after filters combine with AND. tag_level can restrict tag evidence to track or artist; use track evidence for tempo/rhythm hints. Results label Last.fm sources and include Spotify URIs. No network request is made.",
      inputSchema: z.strictObject({
        genre: textFilter,
        tag: textFilter,
        tag_level: z.enum(["any", "track", "artist"]).optional(),
        artist: textFilter,
        year: z.number().int().min(0).max(9999).optional(),
        added_after: addedAfter,
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      runSpotifyTool(async (): Promise<CallToolResult> => {
        const data = await library.getLibrary(input);
        if (data.status === "needs_sync")
          return {
            content: [{ type: "text", text: data.message }],
            structuredContent: data,
          };
        const metadata = {
          total: data.total,
          limit: input.limit,
          offset: input.offset,
          returned: data.tracks.length,
          last_synced_at: data.last_synced_at,
          genre_coverage: data.genre_coverage,
          tag_coverage: data.tag_coverage,
          tag_source: { name: "Last.fm", url: "https://www.last.fm" },
        };
        const lines = data.tracks.map((track) =>
          libraryLine(track, input.genre, input.tag),
        );
        return {
          content: [
            {
              type: "text",
              text: `total=${metadata.total} limit=${input.limit} offset=${input.offset}${data.genre_coverage.spotify_genres_omitted ? " warning=Spotify genre data is missing; genre filtering has incomplete coverage." : ""}\n${lines.join("\n")}`,
            },
          ],
          structuredContent: metadata,
        };
      }),
  );
}
