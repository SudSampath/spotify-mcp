import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CatalogService, SEARCH_TYPES } from "../spotify/catalog.js";
import type { SpotifyClient } from "../spotify/client.js";
import { runSpotifyTool } from "../spotify/session.js";

export const trackInputSchema = z.strictObject({
  artist: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
});

export function registerCatalogTools(
  server: McpServer,
  client: SpotifyClient,
): void {
  const catalog = new CatalogService(client);
  server.registerTool(
    "search",
    {
      description:
        "Search the Spotify catalog. Supports tracks, artists, albums, playlists, shows, episodes, and audiobooks. Limits above ten are capped at ten. Reads Spotify without changing the account.",
      inputSchema: z.strictObject({
        query: z.string().trim().min(1).max(500),
        type: z.enum(SEARCH_TYPES).default("track"),
        limit: z.number().int().positive().default(5),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (input, context) =>
      runSpotifyTool(async () => {
        const data = await catalog.search(
          input.query,
          input.type,
          input.limit,
          context.mcpReq.signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }),
  );
  server.registerTool(
    "resolve_tracks",
    {
      description:
        "Verify up to fifty artist/title suggestions against Spotify. Uses conservative normalized identity matching; different or uncertain versions remain unresolved. Both result groups preserve input order and include original indexes. Only matched entries expose verified Spotify URIs.",
      inputSchema: z.strictObject({
        tracks: z.array(trackInputSchema).min(1).max(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (input, context) =>
      runSpotifyTool(async () => {
        const token = context.mcpReq._meta?.progressToken;
        const data = await catalog.resolveTracks(input.tracks, {
          signal: context.mcpReq.signal,
          onProgress: async (completed, total) => {
            if (typeof token === "string" || typeof token === "number")
              await context.mcpReq.notify({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: completed,
                  total,
                  message: `${completed} of ${total} tracks verified`,
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
