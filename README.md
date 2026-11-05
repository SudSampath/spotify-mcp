# Spotify MCP

Personal Spotify MCP server for Claude Code and Codex, running locally over stdio.
The server has eight playback tools, a direct Spotify Web API client, and PKCE
login with automatic token refresh. It starts without Spotify credentials; tools
return login instructions until you connect your account. Library sync and
playlist curation are planned next.

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

Expected result: the eight playback tools listed below. The pinned Inspector
command requires Node 22.19 or newer. To inspect interactively, omit `--cli` and
`--method tools/list`.

The automated stdio test also verifies the handshake, server identity, tool
capability, ping, and playback tool listing with no inherited credentials.

## Playback tools

| Tool                               | Behavior                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `now_playing`                      | Read the current track, artists, album, position, duration, device, and URI.                                               |
| `list_devices`                     | Read available devices, their IDs, active state, and restrictions.                                                         |
| `play({uri?, query?, device_id?})` | Start a track, album, or playlist URI, or search and play the best matching track. Supply exactly one of `uri` or `query`. |
| `pause({device_id?})`              | Pause playback.                                                                                                            |
| `resume({device_id?})`             | Resume the existing playback context.                                                                                      |
| `next({device_id?})`               | Skip to the next track.                                                                                                    |
| `previous({device_id?})`           | Return to the previous track.                                                                                              |
| `transfer_playback({device_id})`   | Move playback to a device while preserving the playing/paused state.                                                       |

For example, call `play` with `{ "query": "track title artist name" }`. Search
requests five Spotify results and selects the first playable match. Track URIs use
Spotify's `uris` playback field; album and playlist URIs use `context_uri`.

Without `device_id`, controls use an active, unrestricted device. If none exists,
the tool returns `needs_device`, the available devices, and instructions to choose
one. It does not select an inactive device automatically. If no devices are
available, open Spotify on the device you want to use and retry. Explicitly
selected unavailable or restricted devices also return selection instructions.

`now_playing` and `list_devices` are marked read-only; the other tools change
playback and are annotated accordingly. No playback returns a successful idle
response. Spotify errors retain the HTTP status and provider message, including
Premium or permission errors. Playback control requires Spotify Premium.

To verify live reads after login:

```sh
pnpm dlx @modelcontextprotocol/inspector@2.13.0 --cli node dist/index.js --method tools/call --tool-name list_devices
pnpm dlx @modelcontextprotocol/inspector@2.13.0 --cli node dist/index.js --method tools/call --tool-name now_playing
```

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
this token lifecycle. Spotify tools use `runSpotifyTool()` so missing
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

Planned next: library sync, catalog resolution, playlist previews and commits, and
optional Last.fm tag-based discovery.
