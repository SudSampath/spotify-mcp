import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface CallbackListener {
  callbackUrl: string;
  code: Promise<string>;
  close: () => Promise<void>;
}

export async function startCallbackListener(
  expectedState: string,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<CallbackListener> {
  let resolveCode: (value: string) => void;
  let rejectCode: (error: Error) => void;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The browser opener may still be pending when a callback fails.
  void code.catch(() => {});

  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("Invalid callback request.");
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end("Not found.");
      return;
    }
    if (settled) {
      response.writeHead(409).end("This login attempt has already finished.");
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const expected = Buffer.from(expectedState);
    const received = Buffer.from(state);
    const validState =
      url.searchParams.getAll("state").length === 1 &&
      received.length === expected.length &&
      timingSafeEqual(received, expected);
    if (!validState) {
      response
        .writeHead(400)
        .end("Spotify login rejected: state did not match. Run auth again.");
      finish(
        new Error(
          "Spotify login rejected: callback state did not match. Run `pnpm auth` again.",
        ),
      );
      return;
    }
    if (url.searchParams.has("error")) {
      response
        .writeHead(400)
        .end("Spotify login was not approved. You can close this tab.");
      finish(
        new Error(
          "Spotify login was not approved. Run `pnpm auth` to try again.",
        ),
      );
      return;
    }
    const value = url.searchParams.get("code");
    if (!value || url.searchParams.getAll("code").length !== 1) {
      response
        .writeHead(400)
        .end("Spotify did not supply an authorization code. Run auth again.");
      finish(
        new Error(
          "Spotify callback did not include an authorization code. Run `pnpm auth` again.",
        ),
      );
      return;
    }
    response
      .writeHead(200)
      .end(
        "Spotify approval received. You can close this tab and return to the terminal.",
      );
    finish(undefined, value);
  });

  function finish(error?: Error, value?: string) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectCode(error);
    else resolveCode(value ?? "");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          "Could not listen on 127.0.0.1 for Spotify login. Check whether port 8888 is already in use.",
        ),
      ),
    );
    server.listen(options.port ?? 8888, "127.0.0.1", resolve);
  });
  server.on("error", () =>
    finish(
      new Error("Spotify callback listener failed. Run `pnpm auth` again."),
    ),
  );
  timer = setTimeout(
    () => finish(new Error("Spotify login timed out. Run `pnpm auth` again.")),
    options.timeoutMs ?? 120_000,
  );
  const address = server.address() as AddressInfo;
  return {
    callbackUrl: `http://127.0.0.1:${address.port}/callback`,
    code,
    async close() {
      clearTimeout(timer);
      finish(new Error("Spotify login was cancelled. Run `pnpm auth` again."));
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
