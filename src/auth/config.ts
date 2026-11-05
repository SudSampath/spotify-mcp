import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SpotifyConfigError } from "./errors.js";

export const CONFIG_DIRECTORY = join(homedir(), ".config", "spotify-mcp");
const configSchema = z.object({ clientId: z.string().trim().min(1) });

export async function loadClientId(
  directory = CONFIG_DIRECTORY,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const fromEnvironment = environment.SPOTIFY_CLIENT_ID?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const value = JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    );
    const config = configSchema.safeParse(value);
    if (config.success) return config.data.clientId;
  } catch {
    // Configuration errors must not echo file contents or the client ID.
  }
  throw new SpotifyConfigError(
    'Set SPOTIFY_CLIENT_ID or save {"clientId":"your-client-id"} in ~/.config/spotify-mcp/config.json, then run `pnpm auth`.',
  );
}
