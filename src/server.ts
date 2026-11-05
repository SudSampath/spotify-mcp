import { McpServer } from "@modelcontextprotocol/server";
import type { SpotifyClient } from "./spotify/client.js";
import { createSpotifyClient } from "./spotify/session.js";
import { registerPlaybackTools } from "./tools/playback.js";

export function createServer(
  client: SpotifyClient = createSpotifyClient(),
): McpServer {
  const server = new McpServer(
    { name: "spotify-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerPlaybackTools(server, client);
  return server;
}
