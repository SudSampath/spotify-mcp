import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LastfmClient } from "../lastfm/client.js";
import { LastfmEnrichment } from "../lastfm/enrichment.js";
import type { LibraryCache } from "../library/cache.js";

export function registerLastfmTools(
  server: McpServer,
  openCache?: () => Promise<LibraryCache>,
  client = new LastfmClient(),
): void {
  const enrichment = new LastfmEnrichment(client, openCache);
  server.registerTool(
    "get_track_tags",
    {
      description:
        "Read and cache Last.fm community tags for a cached Spotify track URI, or an artist/title pair. Optional artist fallback is returned separately and never presented as track-level or measured BPM/beat data. No Spotify or Last.fm account writes.",
      inputSchema: z
        .strictObject({
          uri: z
            .string()
            .regex(/^spotify:track:[A-Za-z0-9]{22}$/)
            .optional(),
          artist: z.string().trim().min(1).max(200).optional(),
          title: z.string().trim().min(1).max(300).optional(),
          include_artist_fallback: z.boolean().default(false),
          request_budget: z.number().int().min(1).max(5).default(3),
        })
        .refine(
          (input) =>
            input.uri
              ? !input.artist && !input.title
              : Boolean(input.artist && input.title),
          {
            message: "Provide exactly one cached URI, or an artist and title.",
          },
        ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      const data = await enrichment.getTrackTags({
        ...input,
        signal: context.mcpReq.signal,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );
  server.registerTool(
    "enrich_library",
    {
      description:
        "Cache Last.fm tags for a bounded slice of the local Liked Songs library. Artist scope provides broad style hints; track scope provides track-specific tags. Uses a strict HTTP request budget, reports coverage, and returns next_offset; never scans the whole library silently or changes either account.",
      inputSchema: z.strictObject({
        scope: z.enum(["artist", "track"]).default("artist"),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().nonnegative().default(0),
        request_budget: z.number().int().min(1).max(50).default(20),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      let progress = 0;
      const token = context.mcpReq._meta?.progressToken;
      const data = await enrichment.enrichLibrary({
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
    },
  );
}
