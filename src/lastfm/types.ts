export type TagLevel = "track" | "artist";

export interface LastfmTag {
  name: string;
  normalized: string;
  count: number | null;
  url: string;
}

export interface LastfmLookup {
  key: string;
  level: TagLevel;
  artist: string;
  title: string | null;
  tags: LastfmTag[];
  sourceUrl: string;
  fetchedAt: number;
  expiresAt: number;
  notFound: boolean;
}

export interface TagEvidence extends LastfmTag {
  source: "Last.fm";
  level: TagLevel;
  source_url: string;
  fetched_at: string;
  expires_at: string;
}

export function normalizeTag(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
