import { loadClientId } from "./config.js";
import { LoginRequiredError } from "./errors.js";
import { OAuthTokenError, refreshTokens } from "./oauth.js";
import { type SpotifyTokens, TokenStore } from "./token-store.js";

interface TokenManagerOptions {
  store?: TokenStore;
  getClientId?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class TokenManager {
  private readonly store: TokenStore;
  private readonly getClientId: () => Promise<string>;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private refreshing: Promise<string> | undefined;

  constructor(options: TokenManagerOptions = {}) {
    this.store = options.store ?? new TokenStore();
    this.getClientId =
      options.getClientId ?? (() => loadClientId(this.store.directory));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private async load(): Promise<SpotifyTokens> {
    const tokens = await this.store.read();
    if (!tokens || tokens.clientId !== (await this.getClientId()))
      throw new LoginRequiredError();
    return tokens;
  }

  readonly getAccessToken = async (): Promise<string> => {
    const tokens = await this.load();
    return tokens.expiresAt > this.now() + 30_000
      ? tokens.accessToken
      : this.refreshAccessToken();
  };

  readonly refreshAccessToken = async (
    rejectedToken?: string,
  ): Promise<string> => {
    if (this.refreshing) return this.refreshing;
    const operation = this.refresh(rejectedToken);
    this.refreshing = operation;
    try {
      return await operation;
    } finally {
      this.refreshing = undefined;
    }
  };

  private async refresh(rejectedToken?: string): Promise<string> {
    const tokens = await this.load();
    if (!rejectedToken && tokens.expiresAt > this.now() + 30_000) {
      return tokens.accessToken;
    }
    // Another request may have already replaced the token rejected with 401.
    if (
      rejectedToken &&
      rejectedToken !== tokens.accessToken &&
      tokens.expiresAt > this.now() + 30_000
    ) {
      return tokens.accessToken;
    }
    try {
      const updated = await refreshTokens(tokens, {
        clientId: tokens.clientId,
        fetch: this.fetch,
        now: this.now,
      });
      await this.store.write(updated);
      return updated.accessToken;
    } catch (error) {
      if (error instanceof OAuthTokenError && error.loginRequired) {
        const current = await this.store.read();
        if (current?.refreshToken === tokens.refreshToken)
          await this.store.clear();
        throw new LoginRequiredError();
      }
      throw error;
    }
  }
}
