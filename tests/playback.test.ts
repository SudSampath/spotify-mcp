import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_REQUIRED_MESSAGE,
  LoginRequiredError,
} from "../src/auth/errors.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";

const active = {
  id: "synthetic-laptop",
  name: "Test Laptop",
  type: "Computer",
  is_active: true,
  is_restricted: false,
};
const inactive = {
  id: "synthetic-speaker",
  name: "Test Speaker",
  type: "Speaker",
  is_active: false,
  is_restricted: false,
};
const trackUri = "spotify:track:0000000000000000000001";
const track = {
  type: "track",
  name: "Synthetic Uptempo Track",
  uri: trackUri,
  artists: [{ name: "Synthetic Artist" }],
  album: { name: "Synthetic Album" },
  duration_ms: 240_000,
};
let client: Client;
let server: McpServer;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let getAccessToken: ReturnType<typeof vi.fn<() => Promise<string>>>;

beforeEach(async () => {
  fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockRejectedValue(new Error("Unexpected mocked Spotify request"));
  getAccessToken = vi.fn<() => Promise<string>>();
  getAccessToken.mockResolvedValue("synthetic-access-token");
  server = createServer(new SpotifyClient({ fetch, getAccessToken }));
  client = new Client({ name: "synthetic-playback-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});
afterEach(async () => {
  await client.close();
  await server.close();
});

function devices(values = [active, inactive]) {
  fetch.mockResolvedValueOnce(Response.json({ devices: values }));
}
function successfulWrite() {
  fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  return {
    response,
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}
function urls() {
  return fetch.mock.calls.map(([url]) => String(url));
}

describe("Read-only playback", () => {
  it("Given music playing, when now_playing runs, then returns track, position, duration, device and URI", async () => {
    fetch.mockResolvedValueOnce(
      Response.json({
        is_playing: true,
        progress_ms: 42_000,
        device: active,
        item: track,
      }),
    );
    const { response, data } = await call("now_playing");
    expect(response.isError).not.toBe(true);
    expect(data).toEqual({
      status: "playing",
      type: "track",
      title: track.name,
      artists: ["Synthetic Artist"],
      album: "Synthetic Album",
      position_ms: 42_000,
      duration_ms: 240_000,
      device: active,
      uri: trackUri,
    });
    expect(urls()).toEqual(["https://api.spotify.com/v1/me/player"]);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("Given nothing playing, when Spotify returns 204, then reports idle without an error", async () => {
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { response, data } = await call("now_playing");
    expect(response.isError).not.toBe(true);
    expect(data).toEqual({ status: "idle", message: "Nothing is playing." });
  });
  it("Given paused music, when now_playing runs, then preserves the paused context and position", async () => {
    fetch.mockResolvedValueOnce(
      Response.json({
        is_playing: false,
        progress_ms: 12_000,
        device: active,
        item: track,
      }),
    );
    expect((await call("now_playing")).data).toMatchObject({
      status: "paused",
      title: track.name,
      position_ms: 12_000,
    });
  });
  it("Given playing content without track details, when queried, then does not claim nothing is playing", async () => {
    fetch.mockResolvedValueOnce(
      Response.json({
        is_playing: true,
        progress_ms: null,
        device: active,
        item: null,
        currently_playing_type: "ad",
      }),
    );
    expect((await call("now_playing")).data).toMatchObject({
      status: "playing",
      type: "ad",
    });
  });
  it("Given a podcast episode, when queried, then returns its title without requiring track-only metadata", async () => {
    fetch.mockResolvedValueOnce(
      Response.json({
        is_playing: true,
        progress_ms: 100,
        device: active,
        item: {
          type: "episode",
          name: "Synthetic Episode",
          uri: "spotify:episode:0000000000000000000001",
          duration_ms: 3_000,
        },
      }),
    );
    expect((await call("now_playing")).data).toMatchObject({
      type: "episode",
      title: "Synthetic Episode",
      artists: [],
      album: null,
    });
  });
  it("Given available devices, when listed, then returns IDs and active/restricted state without a write", async () => {
    devices();
    expect((await call("list_devices")).data).toEqual({
      devices: [active, inactive],
    });
    expect(urls()).toEqual(["https://api.spotify.com/v1/me/player/devices"]);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });
});

describe("Starting playback", () => {
  it("Given an active device and a query, when play runs, then searches five results and starts the best playable match", async () => {
    devices();
    fetch.mockResolvedValueOnce(
      Response.json({
        tracks: { items: [track, { ...track, name: "Second Candidate" }] },
      }),
    );
    successfulWrite();
    const query = "Synthetic Track & Artist";
    const { response, data } = await call("play", { query });
    expect(response.isError).not.toBe(true);
    expect(data).toMatchObject({
      status: "started",
      uri: trackUri,
      title: track.name,
      artists: ["Synthetic Artist"],
      album: "Synthetic Album",
      device: active,
    });
    const search = new URL(urls()[1] ?? "");
    expect(search.searchParams.get("q")).toBe(query);
    expect(search.searchParams.get("type")).toBe("track");
    expect(search.searchParams.get("limit")).toBe("5");
    expect(urls()[2]).toBe(
      "https://api.spotify.com/v1/me/player/play?device_id=synthetic-laptop",
    );
    expect(fetch.mock.calls[2]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      uris: [trackUri],
    });
  });
  it.each(["track", "album", "playlist"])(
    "Given a %s URI, when play runs, then uses the correct Spotify body",
    async (type) => {
      devices();
      successfulWrite();
      const uri = `spotify:${type}:0000000000000000000001`;
      expect((await call("play", { uri })).data).toMatchObject({
        status: "started",
        uri,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual(
        type === "track" ? { uris: [uri] } : { context_uri: uri },
      );
    },
  );
  it("Given a specified inactive device, when play runs, then targets that device without choosing the active one", async () => {
    devices();
    successfulWrite();
    expect(
      (await call("play", { uri: trackUri, device_id: inactive.id })).data,
    ).toMatchObject({ device: inactive });
    expect(urls()[1]).toContain("device_id=synthetic-speaker");
  });
  it("Given unplayable and malformed search results, when play runs, then skips them before selecting a playable track", async () => {
    devices();
    fetch.mockResolvedValueOnce(
      Response.json({
        tracks: {
          items: [
            { ...track, is_playable: false },
            { name: "Malformed" },
            { ...track, is_local: true },
            track,
          ],
        },
      }),
    );
    successfulWrite();
    expect((await call("play", { query: "synthetic" })).data).toMatchObject({
      uri: trackUri,
    });
  });
  it("Given no search matches, when play runs, then reports no match without sending a playback write", async () => {
    devices();
    fetch.mockResolvedValueOnce(Response.json({ tracks: { items: [] } }));
    const { response } = await call("play", {
      query: "synthetic nonexistent song",
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain(
      "No playable Spotify track matched",
    );
    expect(
      fetch.mock.calls.every(([, options]) => options?.method === "GET"),
    ).toBe(true);
  });
  it.each([
    {},
    { uri: trackUri, query: "both inputs" },
    { query: " " },
    { uri: "https://example.test/track" },
    { uri: "spotify:artist:0000000000000000000001" },
    { uri: trackUri, device_id: " " },
  ])(
    "Given invalid play input %j, when invoked, then returns validation errors before HTTP",
    async (input) => {
      expect((await call("play", input)).response.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("Device selection", () => {
  it("Given no active device, when play runs without device_id, then lists devices and asks for selection without searching or writing", async () => {
    devices([inactive]);
    const { response, data } = await call("play", { query: "synthetic query" });
    expect(response.isError).not.toBe(true);
    expect(data).toMatchObject({ status: "needs_device", devices: [inactive] });
    expect(String(data?.message)).toContain("device_id");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given no available devices, when play runs, then asks the user to open Spotify", async () => {
    devices([]);
    const { data } = await call("play", { uri: trackUri });
    expect(data).toMatchObject({ status: "needs_device", devices: [] });
    expect(String(data?.message)).toContain("Open Spotify");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given a restricted device, when selected, then does not send a playback write", async () => {
    devices([{ ...active, is_restricted: true }]);
    expect(
      (await call("play", { uri: trackUri, device_id: active.id })).data,
    ).toMatchObject({ status: "needs_device" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("Given an unknown device ID, when selected, then returns available devices without writing", async () => {
    devices();
    expect(
      (await call("play", { uri: trackUri, device_id: "synthetic-unknown" }))
        .data,
    ).toMatchObject({ status: "needs_device", devices: [active, inactive] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Playback controls", () => {
  it.each([
    ["pause", "pause", "PUT"],
    ["resume", "play", "PUT"],
    ["next", "next", "POST"],
    ["previous", "previous", "POST"],
  ])(
    "Given an active device, when %s runs, then uses %s with %s",
    async (action, endpoint, method) => {
      devices();
      successfulWrite();
      expect((await call(action)).data).toMatchObject({
        status: "success",
        action,
        device: active,
      });
      expect(urls()[1]).toBe(
        `https://api.spotify.com/v1/me/player/${endpoint}?device_id=synthetic-laptop`,
      );
      expect(fetch.mock.calls[1]?.[1]?.method).toBe(method);
      expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    },
  );
  it("Given a selected device, when transferring, then sends exactly one device ID and preserves playback state", async () => {
    devices();
    successfulWrite();
    expect(
      (await call("transfer_playback", { device_id: inactive.id })).data,
    ).toMatchObject({ status: "transferred", device: inactive });
    expect(urls()[1]).toBe("https://api.spotify.com/v1/me/player");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      device_ids: [inactive.id],
      play: false,
    });
  });
  it("Given HTTP 403, when playback fails, then returns Spotify's reason and keeps the server running", async () => {
    devices();
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { message: "Premium required" } },
        { status: 403 },
      ),
    );
    const { response } = await call("pause");
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("HTTP 403");
    expect(JSON.stringify(response)).toContain("Premium required");
    await expect(client.ping()).resolves.toEqual({});
  });
});

it.each([
  "now_playing",
  "list_devices",
  "play",
  "pause",
  "resume",
  "next",
  "previous",
  "transfer_playback",
])(
  "Given missing login, when %s runs, then returns auth instructions without HTTP and leaves the server alive",
  async (name) => {
    getAccessToken.mockRejectedValue(new LoginRequiredError());
    const args =
      name === "play"
        ? { uri: trackUri }
        : name === "transfer_playback"
          ? { device_id: inactive.id }
          : {};
    const { response } = await call(name, args);
    expect(response).toMatchObject({
      isError: true,
      content: [{ type: "text", text: LOGIN_REQUIRED_MESSAGE }],
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.ping()).resolves.toEqual({});
  },
);
