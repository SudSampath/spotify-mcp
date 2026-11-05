import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  LOGIN_REQUIRED_MESSAGE,
  LoginRequiredError,
  SpotifyConfigError,
} from "../auth/errors.js";
import { TokenManager } from "../auth/token-manager.js";
import { SpotifyClient } from "./client.js";

export function createSpotifyClient(
  manager = new TokenManager(),
): SpotifyClient {
  return new SpotifyClient({
    getAccessToken: manager.getAccessToken,
    refreshAccessToken: manager.refreshAccessToken,
  });
}

/** Shared boundary for Spotify tools: auth failures become MCP results, not crashes. */
export async function runSpotifyTool(
  action: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof LoginRequiredError ||
      error instanceof SpotifyConfigError
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: LOGIN_REQUIRED_MESSAGE }],
      };
    }
    throw error;
  }
}
