import { McpServer } from "@modelcontextprotocol/server";

export function createServer(): McpServer {
  return new McpServer(
    { name: "spotify-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
}
