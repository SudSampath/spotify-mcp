export const jazzArtist = {
  id: "A".repeat(22),
  name: "Synthetic Jazz Artist",
  genres: ["jazz-funk", "jazz"],
};
export const rockArtist = {
  id: "B".repeat(22),
  name: "Synthetic Rock Artist",
  genres: ["alternative rock"],
};
export const unknownArtist = {
  id: "C".repeat(22),
  name: "Synthetic Untagged Artist",
  genres: [] as string[],
};

export function likedSong(
  index: number,
  options: {
    artists?: { id: string; name: string }[];
    year?: number;
    addedAt?: string;
    name?: string;
  } = {},
) {
  const id = index.toString(36).padStart(22, "0");
  return {
    added_at:
      options.addedAt ??
      new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
    track: {
      id,
      uri: `spotify:track:${id}`,
      name: options.name ?? `Synthetic Song ${index}`,
      artists: (options.artists ?? [jazzArtist]).map(({ id, name }) => ({
        id,
        name,
      })),
      album: {
        name: `Synthetic Album ${index}`,
        release_date: `${options.year ?? 2020}-01-01`,
      },
    },
  };
}

export type SyntheticLikedSong = ReturnType<typeof likedSong>;

export function libraryPage(
  items: unknown[],
  next: string | null = null,
): Response {
  return Response.json({ items, next });
}
