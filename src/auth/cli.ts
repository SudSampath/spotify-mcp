import { loadClientId } from "./config.js";
import { authorize } from "./login.js";

try {
  const clientId = await loadClientId();
  console.log("Waiting for Spotify approval in your browser...");
  const account = await authorize({ clientId });
  console.log(
    `Connected to Spotify as ${account.displayName} (${account.id}).`,
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Spotify login failed. Run `pnpm auth` again.",
  );
  process.exitCode = 1;
}
