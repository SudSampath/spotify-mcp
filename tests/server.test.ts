import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

it("Given the built server without credentials, when a stdio client connects, then handshake, ping and empty tool listing succeed", async () => {
  const client = new Client({ name: "spotify-mcp-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: {},
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject({
      name: "spotify-mcp",
      version: "0.1.0",
    });
    expect(client.getServerCapabilities()).toHaveProperty("tools");
    await expect(client.ping()).resolves.toEqual({});
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    expect(stderr).toBe("");
  } finally {
    await client.close();
    await transport.close();
  }
});
