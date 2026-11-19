import { parseArgs } from "node:util";
import { CONFIG_DIRECTORY } from "../auth/config.js";
import { LibraryCache } from "../library/cache.js";
import { LastfmApiError, LastfmClient } from "./client.js";
import { LastfmConfigError, loadLastfmApiKey } from "./config.js";
import { LastfmEnrichment } from "./enrichment.js";

async function main(): Promise<void> {
  let values: {
    scope?: string;
    "max-requests"?: string;
    "data-dir"?: string;
    status?: boolean;
    help?: boolean;
  };
  try {
    values = parseArgs({
      options: {
        scope: { type: "string", default: "all" },
        "max-requests": { type: "string" },
        "data-dir": { type: "string" },
        status: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch {
    throw new Error("Invalid arguments. Run pnpm enrich:all --help.");
  }
  if (values.help) {
    console.log(
      "Usage: pnpm enrich:all [--scope all|artist|track] [--max-requests N] [--status] [--data-dir PATH]\nDefault: artist first, then track; paced at most two requests/second. Successful/empty lookups are durable checkpoints. Rerun to resume. Ctrl-C stops safely. --status reads local coverage without credentials or HTTP.",
    );
    return;
  }
  const scope = values.scope;
  if (scope !== "all" && scope !== "artist" && scope !== "track")
    throw new Error("Invalid arguments. Run pnpm enrich:all --help.");
  const budget =
    values["max-requests"] === undefined
      ? undefined
      : Number(values["max-requests"]);
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1))
    throw new Error("Invalid arguments. Run pnpm enrich:all --help.");
  const directory = values["data-dir"] ?? CONFIG_DIRECTORY;
  const openCache = () => LibraryCache.open(directory);
  if (values.status) {
    const cache = await openCache();
    try {
      console.log(
        JSON.stringify({
          event: "coverage",
          coverage: cache.lastfmCoverage(),
          storage_bytes: cache.lastfmStorageBytes(),
          library_synced_at: cache.state()?.completedAt ?? null,
        }),
      );
    } finally {
      cache.close();
    }
    return;
  }
  const key = await loadLastfmApiKey(directory);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const client = new LastfmClient({
    getApiKey: async () => key,
    minIntervalMs: 500,
  });
  let phase = "";
  let lastPrinted = 0;
  console.log(
    JSON.stringify({
      event: "starting",
      scope,
      pacing_ms: 500,
      pid: process.pid,
    }),
  );
  try {
    const result = await new LastfmEnrichment(client, openCache).enrichAll({
      scope,
      request_budget: budget,
      signal: abort.signal,
      onProgress: async (progress) => {
        if (
          phase !== progress.phase ||
          progress.processed % 25 === 0 ||
          progress.processed === progress.total ||
          Date.now() - lastPrinted >= 10_000
        ) {
          console.log(JSON.stringify({ event: "progress", ...progress }));
          phase = progress.phase;
          lastPrinted = Date.now();
        }
      },
    });
    console.log(JSON.stringify({ event: "finished", ...result }));
    if (result.status === "needs_sync" || result.status === "incomplete")
      process.exitCode = 1;
  } catch (error) {
    if (!abort.signal.aborted) throw error;
    console.log(
      JSON.stringify({
        event: "interrupted",
        message:
          "Stopped safely. Completed lookups are saved; rerun the same command to resume.",
      }),
    );
    process.exitCode = 130;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

await main().catch((error: unknown) => {
  const known =
    error instanceof LastfmApiError ||
    error instanceof LastfmConfigError ||
    (error instanceof Error &&
      /^(Invalid arguments|A library sync|Last\.fm cache)/.test(error.message));
  console.error(
    JSON.stringify({
      event: "error",
      message:
        known && error instanceof Error
          ? error.message
          : "Library enrichment stopped. Completed lookups are saved; check local configuration and rerun to resume.",
    }),
  );
  process.exitCode = 1;
});
