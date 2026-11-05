export const LOGIN_REQUIRED_MESSAGE =
  "Spotify login required. Run `pnpm auth` in the spotify-mcp project, then try again.";

export class LoginRequiredError extends Error {
  override readonly name = "LoginRequiredError";

  constructor() {
    super(LOGIN_REQUIRED_MESSAGE);
  }
}

export class SpotifyConfigError extends Error {
  override readonly name = "SpotifyConfigError";
}
