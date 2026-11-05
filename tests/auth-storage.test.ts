import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadClientId } from "../src/auth/config.js";
import { LoginRequiredError } from "../src/auth/errors.js";
import { type SpotifyTokens, TokenStore } from "../src/auth/token-store.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spotify-mcp-auth-storage-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const tokens: SpotifyTokens = {
  clientId: "synthetic-client",
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
  expiresAt: 2_000_000_000_000,
  scope: "user-library-read",
};

describe("Client ID configuration", () => {
  it("Given an environment client ID, when loading configuration, then it takes precedence", async () => {
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({ clientId: "synthetic-file-client" }),
    );
    await expect(
      loadClientId(directory, { SPOTIFY_CLIENT_ID: " synthetic-env-client " }),
    ).resolves.toBe("synthetic-env-client");
  });
  it("Given a local config file, when loading configuration, then reads clientId", async () => {
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({ clientId: "synthetic-file-client" }),
    );
    await expect(loadClientId(directory, {})).resolves.toBe(
      "synthetic-file-client",
    );
  });
  it("Given missing configuration, when loading, then explains local setup and auth", async () => {
    await expect(loadClientId(directory, {})).rejects.toThrow(
      "~/.config/spotify-mcp/config.json",
    );
    await expect(loadClientId(directory, {})).rejects.toThrow("pnpm auth");
  });
  it("Given malformed configuration, when loading fails, then does not echo file contents", async () => {
    await writeFile(join(directory, "config.json"), "synthetic-private-value");
    await expect(loadClientId(directory, {})).rejects.not.toThrow(
      "synthetic-private-value",
    );
  });
});

describe("Token storage", () => {
  it("Given a new token store, when saved, then the directory is 0700 and tokens are 0600", async () => {
    const store = new TokenStore(join(directory, "private"));
    await store.write(tokens);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await expect(store.read()).resolves.toEqual(tokens);
    expect(await readdir(store.directory)).toEqual(["tokens.json"]);
  });
  it("Given existing credentials, when rotated, then atomically replaces tokens without temporary files", async () => {
    const store = new TokenStore(directory);
    await store.write(tokens);
    await store.write({ ...tokens, refreshToken: "synthetic-rotated-refresh" });
    expect(JSON.parse(await readFile(store.path, "utf8")).refreshToken).toBe(
      "synthetic-rotated-refresh",
    );
    expect(await readdir(directory)).toEqual(["tokens.json"]);
  });
  it("Given permissive token-file permissions, when read, then restricts them to 0600", async () => {
    const store = new TokenStore(directory);
    await store.write(tokens);
    await chmod(store.path, 0o644);
    await store.read();
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });
  it("Given missing tokens, when read, then returns null without creating files", async () => {
    await expect(new TokenStore(directory).read()).resolves.toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([
    "not JSON: synthetic-private-value",
    '{"accessToken":"synthetic-private-value"}',
  ])(
    "Given corrupt tokens, when read, then requests login without exposing credentials",
    async (value) => {
      const store = new TokenStore(directory);
      await writeFile(store.path, value);
      await expect(store.read()).rejects.toBeInstanceOf(LoginRequiredError);
      await expect(store.read()).rejects.not.toThrow("synthetic-private-value");
    },
  );
});
