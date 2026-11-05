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
import { CONFIG_DIRECTORY } from "./config.js";
import { LoginRequiredError } from "./errors.js";

const tokensSchema = z.object({
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  scope: z.string(),
});

export type SpotifyTokens = z.infer<typeof tokensSchema>;

export class TokenStore {
  readonly path: string;

  constructor(readonly directory = CONFIG_DIRECTORY) {
    this.path = join(directory, "tokens.json");
  }

  async read(): Promise<SpotifyTokens | null> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(
        "Could not read Spotify token storage. Check its permissions.",
      );
    }
    try {
      const tokens = tokensSchema.safeParse(JSON.parse(contents));
      if (tokens.success) {
        await chmod(this.path, 0o600);
        return tokens.data;
      }
    } catch {
      // Do not expose tokens through JSON/schema error messages.
    }
    throw new LoginRequiredError();
  }

  async write(tokens: SpotifyTokens): Promise<void> {
    const parsed = tokensSchema.safeParse(tokens);
    if (!parsed.success) throw new Error("Cannot save invalid Spotify tokens.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporaryPath = join(this.directory, `.tokens-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(parsed.data), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
