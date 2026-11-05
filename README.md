# Spotify MCP

Personal Spotify MCP server for Claude Code and Codex, running locally over stdio.
The server has a direct Spotify Web API client and PKCE login with automatic token
refresh. It currently lists zero tools and starts without Spotify credentials.
Playback and playlist tools are the next tickets.

## Develop

Use Node **22.12 or newer** and **pnpm 10.33.0**. The MCP SDK requires Node 20 or
newer; the test runner requires Node 22.12 or newer.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`check` runs lint/format validation, TypeScript checking, a production build, and
tests. `pnpm test` builds before testing so the stdio integration test always runs
the current code. HTTP fixtures and credentials in tests are synthetic; no Spotify
account or network access is needed to run the tests.

```sh
pnpm format     # Apply formatting and safe lint fixes
pnpm build     # Compile src/ to dist/
node dist/index.js
```

The server waits for MCP messages on stdin. Use `node` with the absolute path to
`dist/index.js` when configuring an MCP host. stdout carries only MCP messages;
diagnostics belong on stderr.

## Verify with MCP Inspector

After building:

```sh
pnpm dlx @modelcontextprotocol/inspector@2.13.0 --cli node dist/index.js --method tools/list
```

Expected result: `{ "tools": [] }`. The pinned Inspector command requires Node
22.19 or newer. To inspect interactively, omit `--cli` and `--method tools/list`.

The automated stdio test also verifies the handshake, server identity, tool
capability, ping, and empty tool listing with no inherited credentials.

## Connect your Spotify account

1. Create a personal app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   with Web API enabled and redirect URI **`http://127.0.0.1:8888/callback`**.
2. Save its client ID to `~/.config/spotify-mcp/config.json`:

   ```json
   { "clientId": "your-client-id" }
   ```

   Alternatively, set `SPOTIFY_CLIENT_ID` in your local environment. Keep the actual
   value outside the repository and chat. No client secret is used.
3. Run `chmod 600 ~/.config/spotify-mcp/config.json` if using the file.
4. From this project, run `pnpm auth` and approve Spotify's permission screen.
   The command opens your default Mac browser, listens on loopback for up to two
   minutes, validates the callback state, and prints the connected account.

Tokens are saved atomically to `~/.config/spotify-mcp/tokens.json` with mode `0600`;
the directory is restricted to `0700`. Access tokens refresh 30 seconds before
expiry. A Spotify 401 triggers one refresh and one retry. Rotated refresh tokens
replace the old value; a refresh response without one preserves the existing
refresh token. Revoked credentials ask you to run `pnpm auth` again.

`createSpotifyClient()` in `src/spotify/session.ts` connects the HTTP client to
this token lifecycle. Future Spotify tools must use `runSpotifyTool()` so missing
or revoked credentials produce readable MCP errors and leave the server running.
The server reads tokens lazily, so a successful login also fixes an already-running
server's next Spotify call.

The tests cover the full browser-callback flow over loopback with mocked Spotify
responses, including rejected state, denied approval, timeout, private file modes,
token refresh/rotation, concurrent refreshes in one process, and bounded 401
recovery. No real credentials are test fixtures.

## Spotify HTTP client

`src/spotify/client.ts` exports `SpotifyClient` and `SpotifyApiError`:

- Inject `getAccessToken`, a synchronous or asynchronous function returning an
  access token, and optionally `refreshAccessToken` for one-time 401 recovery.
  `createSpotifyClient()` supplies both from the local OAuth token manager.
- `request<T>("/me/tracks")` resolves paths under
  `https://api.spotify.com/v1/`. It sends bearer authorization, accepts JSON,
  supports JSON write bodies, and returns `undefined` for HTTP 204.
- HTTP errors include the status and Spotify's message. HTTP 429 waits for
  `Retry-After` before retrying, with three retries by default. A missing or invalid
  header falls back to one second; exhaustion throws a rate-limit error. Network
  failures and other HTTP errors are not automatically retried.
- `getAll<T>(path)` follows `next` links and returns every item in order. It checks
  page envelopes and rejects repeated pages and URLs outside the Spotify API.
  Callers supply the item type; per-endpoint item validation belongs with the
  future Spotify tools.
- Inject `fetch` and optionally `sleep` for deterministic HTTP tests.

Use Spotify's current endpoints in subsequent tickets: `/playlists/{id}/items`,
`POST /me/playlists`, and `/me/library` for library writes.

## Local data

Keep tokens, configuration, and the future library database under
`~/.config/spotify-mcp/`, outside the repository. `.gitignore` also excludes local
agent state, dependencies, build output, environment files, credential files, and
SQLite data. Use only synthetic fixtures in the repository.

## References and next work

- [Official MCP SDK stdio guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
- [Spotify API calls](https://developer.spotify.com/documentation/web-api/concepts/api-calls)
- [Spotify rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)
- [Spotify PKCE login](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Spotify token refresh](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)

Planned next: playback tools, followed by library sync, catalog resolution, playlist
previews and commits, and optional Last.fm tag-based discovery.
