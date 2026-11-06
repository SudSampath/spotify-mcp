import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { saveLastfmApiKey } from "./config.js";

try {
  if (!process.stdin.isTTY)
    throw new Error(
      "Run `pnpm lastfm:configure` in an interactive Terminal window.",
    );
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  const controller = new AbortController();
  reader.on("SIGINT", () => controller.abort());
  reader.on("close", () => controller.abort());
  process.stderr.write(
    "Paste your Last.fm API key (input hidden), then press Enter: ",
  );
  let value: string;
  try {
    value = await reader.question("", { signal: controller.signal });
  } finally {
    reader.close();
    process.stderr.write("\n");
  }
  await saveLastfmApiKey(value);
  console.log("Last.fm API key saved locally with restricted permissions.");
} catch {
  console.error(
    "Last.fm setup did not complete. Run `pnpm lastfm:configure` in Terminal and paste a valid API key.",
  );
  process.exitCode = 1;
}
