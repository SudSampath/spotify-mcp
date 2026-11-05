import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SpotifyClient } from "../spotify/client.js";
import {
  DeviceSelectionRequired,
  PlaybackService,
  spotifyPlaybackUri,
} from "../spotify/playback.js";
import { runSpotifyTool } from "../spotify/session.js";

const deviceId = z.string().trim().min(1).max(512);
const deviceInput = z.strictObject({ device_id: deviceId.optional() });
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};
const changesPlayback = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

function result(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

async function playbackTool(
  action: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  return runSpotifyTool(async () => {
    try {
      return result(await action());
    } catch (error) {
      if (error instanceof DeviceSelectionRequired) {
        return result({
          status: "needs_device",
          message: error.message,
          devices: error.devices,
        });
      }
      throw error;
    }
  });
}

export function registerPlaybackTools(
  server: McpServer,
  client: SpotifyClient,
): void {
  const playback = new PlaybackService(client);
  server.registerTool(
    "now_playing",
    {
      description:
        "Read current Spotify playback, track details, position, duration, and device. Does not change playback.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    () => playbackTool(() => playback.nowPlaying()),
  );
  server.registerTool(
    "list_devices",
    {
      description:
        "Read available Spotify devices, including IDs, active state, and restrictions. Does not change playback.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    () => playbackTool(async () => ({ devices: await playback.listDevices() })),
  );
  server.registerTool(
    "play",
    {
      description:
        "Change Spotify playback: start a track, album, or playlist URI, or search for and play the best track for a query. Provide exactly one of uri or query. Without an active device, returns available devices for selection.",
      inputSchema: z
        .strictObject({
          uri: z
            .string()
            .regex(
              spotifyPlaybackUri,
              "Use a Spotify track, album, or playlist URI.",
            )
            .optional(),
          query: z.string().trim().min(1).max(500).optional(),
          device_id: deviceId.optional(),
        })
        .refine(
          (input) =>
            Number(Boolean(input.uri)) + Number(Boolean(input.query)) === 1,
          {
            message:
              "Provide exactly one of uri or query. Use resume to continue current playback.",
          },
        ),
      annotations: changesPlayback,
    },
    (input) => playbackTool(() => playback.play(input)),
  );
  const actions = [
    ["pause", "Pause Spotify playback."],
    [
      "resume",
      "Resume the current Spotify playback context without selecting a new track.",
    ],
    ["next", "Change Spotify playback by skipping to the next track."],
    ["previous", "Change Spotify playback by returning to the previous track."],
  ] as const;
  for (const [action, description] of actions) {
    server.registerTool(
      action,
      {
        description,
        inputSchema: deviceInput,
        annotations: changesPlayback,
      },
      ({ device_id }) =>
        playbackTool(() => playback.control(action, device_id)),
    );
  }
  server.registerTool(
    "transfer_playback",
    {
      description:
        "Move Spotify playback to the selected available device, preserving whether playback is playing or paused.",
      inputSchema: z.strictObject({ device_id: deviceId }),
      annotations: changesPlayback,
    },
    ({ device_id }) => playbackTool(() => playback.transferPlayback(device_id)),
  );
}
