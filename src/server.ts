import { McpServer } from "@modelcontextprotocol/server";
import { LastfmClient } from "./lastfm/client.js";
import type { LibraryCache } from "./library/cache.js";
import type { SpotifyClient } from "./spotify/client.js";
import { createSpotifyClient } from "./spotify/session.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
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
  registerCatalogTools(server, client);
  registerLibraryTools(server, client, openLibraryCache);
  const lastfm = lastfmClient ?? new LastfmClient();
  registerLastfmTools(server, openLibraryCache, lastfm);
  registerDiscoveryTools(server, client, openLibraryCache, lastfm);
  return server;
}
