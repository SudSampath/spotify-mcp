export function catalogTrack(
  index = 1,
  options: {
    name?: string;
    artists?: string[];
    year?: number;
    album?: string;
    uri?: string;
    playable?: boolean;
  } = {},
) {
  const id = index.toString(36).padStart(22, "0");
  return {
    type: "track",
    name: options.name ?? "Synthetic Song",
    uri: options.uri ?? `spotify:track:${id}`,
    artists: (options.artists ?? ["Synthetic Artist"]).map((name) => ({
      name,
    })),
    album: {
      name: options.album ?? "Synthetic Album",
      release_date: `${options.year ?? 2020}-01-01`,
    },
    ...(options.playable === undefined
      ? {}
      : { is_playable: options.playable }),
  };
}

export function searchPage(items: unknown[], type = "track") {
  return Response.json({ [`${type}s`]: { items, total: items.length } });
}
