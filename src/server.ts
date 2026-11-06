import { McpServer } from "@modelcontextprotocol/server";
import type { LastfmClient } from "./lastfm/client.js";
import type { LibraryCache } from "./library/cache.js";
import type { SpotifyClient } from "./spotify/client.js";
import { createSpotifyClient } from "./spotify/session.js";
import { registerLastfmTools } from "./tools/lastfm.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerPlaybackTools } from "./tools/playback.js";

export function createServer(
  client: SpotifyClient = createSpotifyClient(),
  openLibraryCache?: () => Promise<LibraryCache>,
  lastfmClient?: LastfmClient,
): McpServer {
  const server = new McpServer(
    { name: "spotify-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerPlaybackTools(server, client);
  registerLibraryTools(server, client, openLibraryCache);
  registerLastfmTools(server, openLibraryCache, lastfmClient);
  return server;
}
