import { execFile } from "node:child_process";
import { z } from "zod";
import { SpotifyClient } from "../spotify/client.js";
import { type CallbackListener, startCallbackListener } from "./callback.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
} from "./oauth.js";
import { TokenStore } from "./token-store.js";

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", [url], { timeout: 5_000 }, (error) => {
      if (error)
        reject(
          new Error(
            "Could not open your browser. Run `pnpm auth` from an interactive Mac session.",
          ),
        );
      else resolve();
    });
  });
}

interface LoginOptions {
  clientId: string;
  store?: TokenStore;
  fetch?: typeof globalThis.fetch;
  openBrowser?: (url: string) => Promise<void>;
  listen?: (state: string) => Promise<CallbackListener>;
}

export async function authorize(options: LoginOptions) {
  const request = createAuthorizationRequest(options.clientId);
  const listener = await (options.listen ?? startCallbackListener)(
    request.state,
  );
  try {
    await (options.openBrowser ?? openBrowser)(request.authorizationUrl);
    const tokens = await exchangeAuthorizationCode({
      clientId: options.clientId,
      code: await listener.code,
      verifier: request.verifier,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const client = new SpotifyClient({
      getAccessToken: () => tokens.accessToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const profile = z
      .object({
        id: z.string().min(1),
        display_name: z.string().nullable().optional(),
      })
      .safeParse(await client.request("/me"));
    if (!profile.success)
      throw new Error(
        "Spotify did not return an account identity. Run `pnpm auth` again.",
      );
    await (options.store ?? new TokenStore()).write(tokens);
    return {
      id: profile.data.id,
      displayName: profile.data.display_name ?? profile.data.id,
    };
  } finally {
    await listener.close();
  }
}
