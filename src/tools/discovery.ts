import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LastfmClient } from "../lastfm/client.js";
import { DiscoveryService } from "../lastfm/discovery.js";
import type { LibraryCache } from "../library/cache.js";
import { CatalogService } from "../spotify/catalog.js";
import type { SpotifyClient } from "../spotify/client.js";
import { runSpotifyTool } from "../spotify/session.js";
import { trackInputSchema } from "./catalog.js";

export function registerDiscoveryTools(
  server: McpServer,
  spotify: SpotifyClient,
  openCache?: () => Promise<LibraryCache>,
  lastfm = new LastfmClient(),
): void {
  const discovery = new DiscoveryService(
    new CatalogService(spotify),
    lastfm,
    openCache,
  );
  server.registerTool(
    "discover_tracks",
    {
      description:
        "Find tracks from Last.fm tags and/or example artist/title seeds. Supported cached library matches precede catalog additions; catalog identities are verified against Spotify. Multiple tags require evidence for every tag. Unknown or ambiguous matches stay unresolved. tag_level controls cached library evidence; use track for tempo/rhythm hints. Tags and similarity are qualitative, not measured audio features. Returns suggestions only; never changes playlists or accounts.",
      inputSchema: z
        .strictObject({
          tags: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
          seeds: z.array(trackInputSchema).max(5).default([]),
          limit: z.number().int().min(1).max(50).default(20),
          tag_level: z.enum(["any", "track", "artist"]).default("any"),
          request_budget: z.number().int().min(1).max(20).default(10),
          resolve_limit: z.number().int().min(1).max(50).default(20),
        })
        .refine((input) => input.tags.length + input.seeds.length > 0, {
          message: "Provide at least one tag or seed track.",
        }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (input, context) =>
      runSpotifyTool(async () => {
        let progress = 0;
        const token = context.mcpReq._meta?.progressToken;
        const data = await discovery.discover({
          ...input,
          signal: context.mcpReq.signal,
          onProgress: async (message) => {
            if (typeof token === "string" || typeof token === "number")
              await context.mcpReq.notify({
                method: "notifications/progress",
                params: { progressToken: token, progress: ++progress, message },
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
