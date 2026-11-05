import { McpServer } from "@modelcontextprotocol/server";
import type { LibraryCache } from "./library/cache.js";
import type { SpotifyClient } from "./spotify/client.js";
import { createSpotifyClient } from "./spotify/session.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerPlaybackTools } from "./tools/playback.js";

export function createServer(
  client: SpotifyClient = createSpotifyClient(),
  openLibraryCache?: () => Promise<LibraryCache>,
): McpServer {
  const server = new McpServer(
    { name: "spotify-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerPlaybackTools(server, client);
  registerLibraryTools(server, client, openLibraryCache);
  return server;
}
