import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG_DIRECTORY } from "../auth/config.js";

const apiKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Fa-f0-9]{32}$/);

export class LastfmConfigError extends Error {
  override readonly name = "LastfmConfigError";
  constructor() {
    super(
      "Last.fm API key is missing or invalid. Run `pnpm lastfm:configure` locally, or set LASTFM_API_KEY. Existing Spotify tools still work.",
    );
  }
}

export async function loadLastfmApiKey(
  directory = CONFIG_DIRECTORY,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const environmentKey = environment.LASTFM_API_KEY;
  if (environmentKey !== undefined) {
    const parsed = apiKeySchema.safeParse(environmentKey);
    if (parsed.success) return parsed.data;
    throw new LastfmConfigError();
  }
  try {
    const value = JSON.parse(
      await readFile(join(directory, "lastfm.json"), "utf8"),
    );
    const parsed = z.object({ apiKey: apiKeySchema }).safeParse(value);
    if (parsed.success) return parsed.data.apiKey;
  } catch {
    // Never echo configuration contents or parser errors.
  }
  throw new LastfmConfigError();
}

export async function saveLastfmApiKey(
  value: string,
  directory = CONFIG_DIRECTORY,
): Promise<void> {
  const parsed = apiKeySchema.safeParse(value);
  if (!parsed.success) throw new LastfmConfigError();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.lastfm-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ apiKey: parsed.data }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, join(directory, "lastfm.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
