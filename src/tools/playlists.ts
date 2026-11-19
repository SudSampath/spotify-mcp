import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LibraryCache } from "../library/cache.js";
import { PlaylistService } from "../playlist/service.js";
import type { SpotifyClient } from "../spotify/client.js";
import { runSpotifyTool } from "../spotify/session.js";

const uris = z.array(z.string().max(2048)).min(1).max(500);
const playlistId = z.string().regex(/^[A-Za-z0-9]{22}$/);
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

export function registerPlaylistTools(
  server: McpServer,
  client: SpotifyClient,
  openCache?: () => Promise<LibraryCache>,
): void {
  const playlists = new PlaylistService(client, openCache);
  server.registerTool(
    "list_playlists",
    {
      description:
        "List current Spotify user's playlists with ownership, track counts and URLs. Read-only; use limit/offset to page through results.",
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(100_000).default(0),
      }),
      annotations: readOnly,
    },
    (input, context) =>
      runSpotifyTool(async () => {
        const data = await playlists.list(
          input.limit,
          input.offset,
          context.mcpReq.signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }),
  );
  server.registerTool(
    "create_playlist",
    {
      description:
        "PREVIEW ONLY: validate up to 500 track URIs, remove and list duplicates, flag invalid/unavailable tracks, and show library/catalog membership in order. Creates a local preview token expiring in 30 minutes; makes no Spotify changes. Show the full preview and obtain explicit user approval before commit_playlist. Defaults to a private playlist.",
      inputSchema: z.strictObject({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(300).default(""),
        public: z.boolean().default(false),
        uris,
      }),
      annotations: readOnly,
    },
    (input, context) =>
      runSpotifyTool(async () => {
        const data = await playlists.preview(input, {
          signal: context.mcpReq.signal,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }),
  );
  server.registerTool(
    "add_to_playlist",
    {
      description:
        "PREVIEW ONLY: prepare additions to an owned or collaborative playlist. Does not write to Spotify. Validates the target and tracks and preserves input order; deduplicates this request, not existing playlist contents. Show the preview and obtain explicit user approval before commit_playlist performs the write.",
      inputSchema: z.strictObject({ playlist_id: playlistId, uris }),
      annotations: readOnly,
    },
    (input, context) =>
      runSpotifyTool(async () => {
        const data = await playlists.preview(input, {
          signal: context.mcpReq.signal,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }),
  );
  server.registerTool(
    "commit_playlist",
    {
      description:
        "WRITES TO SPOTIFY. Call only after the user explicitly approves this exact preview. Consumes a single-use preview_id to create the approved playlist or append approved tracks in batches of 100. Repeated calls never repeat writes. Partial/uncertain failures report progress and must be reviewed manually; never automatically retry them or prepare a replacement preview.",
      inputSchema: z.strictObject({ preview_id: z.uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, context) =>
      runSpotifyTool(async () => {
        const token = context.mcpReq._meta?.progressToken;
        const data = await playlists.commit(input.preview_id, {
          signal: context.mcpReq.signal,
          onProgress: async (added, total) => {
            if (typeof token === "string" || typeof token === "number")
              await context.mcpReq.notify({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: added,
                  total,
                  message: `${added} of ${total} approved tracks added`,
                },
              });
          },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }),
  );
}
