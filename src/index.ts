import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

// stdout belongs to MCP. Any future diagnostics must go to stderr.
serveStdio(() => createServer(), {
  onerror: () => {
    console.error("Spotify MCP transport error.");
    process.exitCode = 1;
  },
});
