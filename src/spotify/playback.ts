import { z } from "zod";
import type { SpotifyClient } from "./client.js";

export const spotifyPlaybackUri =
  /^spotify:(track|album|playlist):[A-Za-z0-9]{22}$/;

const deviceSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  is_active: z.boolean(),
  is_restricted: z.boolean(),
});
const devicesSchema = z.object({ devices: z.array(deviceSchema) });
const artistSchema = z.object({ name: z.string() });
const trackSchema = z.object({
  name: z.string(),
  artists: z.array(artistSchema),
  album: z.object({ name: z.string() }),
  uri: z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/),
  is_playable: z.boolean().optional(),
  is_local: z.boolean().optional(),
});
const playbackSchema = z.object({
  is_playing: z.boolean(),
  progress_ms: z.number().nonnegative().nullable(),
  device: deviceSchema,
  currently_playing_type: z.string().optional(),
  item: z
    .object({
      type: z.string(),
      name: z.string(),
      uri: z.string(),
      duration_ms: z.number().nonnegative(),
      artists: z.array(artistSchema).optional(),
      album: z.object({ name: z.string() }).optional(),
    })
    .nullable(),
});
const searchSchema = z.object({
  tracks: z.object({ items: z.array(z.unknown()) }),
});

export type PlaybackDevice = z.infer<typeof deviceSchema>;
export interface PlayInput {
  uri?: string | undefined;
  query?: string | undefined;
  device_id?: string | undefined;
}

export class DeviceSelectionRequired extends Error {
  override readonly name = "DeviceSelectionRequired";

  constructor(
    message: string,
    readonly devices: PlaybackDevice[],
  ) {
    super(message);
  }
}

export class PlaybackService {
  constructor(private readonly client: SpotifyClient) {}

  async listDevices(): Promise<PlaybackDevice[]> {
    const parsed = devicesSchema.safeParse(
      await this.client.request("/me/player/devices"),
    );
    if (!parsed.success)
      throw new Error("Spotify returned an invalid device list.");
    return parsed.data.devices;
  }

  private async chooseDevice(
    deviceId?: string,
  ): Promise<PlaybackDevice & { id: string }> {
    const devices = await this.listDevices();
    const selected = deviceId
      ? devices.find((device) => device.id === deviceId)
      : devices.find(
          (device) => device.is_active && device.id && !device.is_restricted,
        );
    if (selected?.id && !selected.is_restricted) {
      return { ...selected, id: selected.id };
    }
    const message =
      devices.length === 0
        ? "No Spotify devices are available. Open Spotify on the device you want to use, then retry."
        : deviceId
          ? "That Spotify device is unavailable or restricted. Choose an available, unrestricted device and retry with device_id."
          : "No active Spotify device. Choose an available, unrestricted device and retry with device_id.";
    throw new DeviceSelectionRequired(message, devices);
  }

  async nowPlaying() {
    const response = await this.client.request("/me/player");
    if (response === undefined || response === null) {
      return { status: "idle", message: "Nothing is playing." };
    }
    const parsed = playbackSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Spotify returned an invalid playback response.");
    const playback = parsed.data;
    const item = playback.item;
    if (!item) {
      return {
        status: playback.is_playing ? "playing" : "idle",
        message: playback.is_playing
          ? "Spotify is playing content without track details."
          : "Nothing is playing.",
        type: playback.currently_playing_type ?? "unknown",
        device: playback.device,
      };
    }
    return {
      status: playback.is_playing ? "playing" : "paused",
      type: item.type,
      title: item.name,
      artists: item.artists?.map((artist) => artist.name) ?? [],
      album: item.album?.name ?? null,
      position_ms: playback.progress_ms,
      duration_ms: item.duration_ms,
      device: playback.device,
      uri: item.uri,
    };
  }

  async play(input: PlayInput) {
    if (Number(Boolean(input.uri)) + Number(Boolean(input.query)) !== 1) {
      throw new Error(
        "Provide exactly one of uri or query. Use resume to continue current playback.",
      );
    }
    if (input.uri && !spotifyPlaybackUri.test(input.uri)) {
      throw new Error("Use a Spotify track, album, or playlist URI.");
    }
    const device = await this.chooseDevice(input.device_id);
    let uri = input.uri;
    let track: z.infer<typeof trackSchema> | undefined;
    if (input.query) {
      const parameters = new URLSearchParams({
        q: input.query,
        type: "track",
        limit: "5",
      });
      const search = searchSchema.safeParse(
        await this.client.request(`/search?${parameters}`),
      );
      if (!search.success)
        throw new Error("Spotify returned an invalid search response.");
      for (const candidate of search.data.tracks.items) {
        const parsed = trackSchema.safeParse(candidate);
        if (
          parsed.success &&
          parsed.data.is_playable !== false &&
          parsed.data.is_local !== true
        ) {
          track = parsed.data;
          uri = track.uri;
          break;
        }
      }
      if (!track)
        throw new Error(
          "No playable Spotify track matched that query. Try a title and artist.",
        );
    }
    if (!uri) throw new Error("No Spotify URI was selected.");
    const body = uri.startsWith("spotify:track:")
      ? { uris: [uri] }
      : { context_uri: uri };
    await this.client.request(
      `/me/player/play?${new URLSearchParams({ device_id: device.id })}`,
      { method: "PUT", body },
    );
    return {
      status: "started",
      uri,
      device,
      ...(track
        ? {
            title: track.name,
            artists: track.artists.map((artist) => artist.name),
            album: track.album.name,
          }
        : {}),
    };
  }

  async control(
    action: "pause" | "resume" | "next" | "previous",
    deviceId?: string,
  ) {
    const device = await this.chooseDevice(deviceId);
    const endpoint = action === "resume" ? "play" : action;
    const method = action === "next" || action === "previous" ? "POST" : "PUT";
    await this.client.request(
      `/me/player/${endpoint}?${new URLSearchParams({ device_id: device.id })}`,
      { method },
    );
    return { status: "success", action, device };
  }

  async transferPlayback(deviceId: string) {
    const device = await this.chooseDevice(deviceId);
    await this.client.request("/me/player", {
      method: "PUT",
      body: { device_ids: [device.id], play: false },
    });
    return { status: "transferred", device };
  }
}
