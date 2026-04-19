/**
 * OAuth provider interface.
 *
 * Each provider (Anthropic, GitHub Copilot, etc.) implements this.
 * Two OAuth flows:
 * - Authorization Code: browser redirect
 * - Device Code: show code, user enters at URL, agent polls
 */

export interface OAuthProvider {
  id: string;
  name: string;
  startLogin(): Promise<LoginResult>;
  exchangeCode?(code: string): Promise<TokenResult>;
  pollDeviceAuth?(deviceCode: string): Promise<TokenResult | null>;
  refreshToken(refreshToken: string): Promise<TokenResult | null>;
}

export interface LoginResult {
  type: "browser" | "device";
  authUrl?: string;
  userCode?: string;
  verificationUrl?: string;
  deviceCode?: string;
  pollInterval?: number;
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes?: string[];
}

const providers = new Map<string, OAuthProvider>();

export function registerOAuthProvider(provider: OAuthProvider): void {
  providers.set(provider.id, provider);
}

export function getOAuthProvider(id: string): OAuthProvider | undefined {
  return providers.get(id);
}

export function getOAuthProviders(): OAuthProvider[] {
  return [...providers.values()];
}

/**
 * Register built-in OAuth providers.
 * Client IDs can be configured via environment variables or passed directly.
 */
export function registerBuiltinOAuthProviders(config?: {
  anthropicClientId?: string;
  githubCopilotClientId?: string;
}): void {
  const anthropicClientId = config?.anthropicClientId || process.env.ANTHROPIC_OAUTH_CLIENT_ID;
  const githubClientId = config?.githubCopilotClientId || process.env.GITHUB_COPILOT_CLIENT_ID;

  if (anthropicClientId) {
    registerOAuthProvider(createAnthropicOAuthProvider(anthropicClientId));
  }

  if (githubClientId) {
    registerOAuthProvider(createGitHubCopilotOAuthProvider(githubClientId));
  }
}

export function createAnthropicOAuthProvider(clientId: string): OAuthProvider {
  const REDIRECT_URI = "http://localhost:9876/callback";

  return {
    id: "anthropic",
    name: "Anthropic (Claude Pro/Max)",

    async startLogin() {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "messages:write",
      });

      return {
        type: "browser",
        authUrl: `https://console.anthropic.com/oauth/authorize?${params}`,
      };
    },

    async exchangeCode(code: string) {
      const response = await fetch("https://console.anthropic.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code,
        }),
      });

      if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
      const data = await response.json() as Record<string, unknown>;

      return {
        accessToken: data.access_token as string,
        refreshToken: data.refresh_token as string,
        expiresIn: (data.expires_in as number) || 3600,
      };
    },

    async refreshToken(refreshToken: string) {
      const response = await fetch("https://console.anthropic.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) return null;
      const data = await response.json() as Record<string, unknown>;

      return {
        accessToken: data.access_token as string,
        refreshToken: (data.refresh_token as string) || refreshToken,
        expiresIn: (data.expires_in as number) || 3600,
      };
    },
  };
}

export function createGitHubCopilotOAuthProvider(clientId: string): OAuthProvider {
  return {
    id: "github-copilot",
    name: "GitHub Copilot",

    async startLogin() {
      const response = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          scope: "copilot",
        }),
      });

      const data = await response.json() as Record<string, unknown>;

      return {
        type: "device",
        userCode: data.user_code as string,
        verificationUrl: data.verification_uri as string,
        deviceCode: data.device_code as string,
        pollInterval: (data.interval as number) || 5,
      };
    },

    async pollDeviceAuth(deviceCode: string) {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      const data = await response.json() as Record<string, unknown>;
      if (data.error === "authorization_pending") return null;
      if (data.error) throw new Error((data.error_description as string) || (data.error as string));

      return {
        accessToken: data.access_token as string,
        refreshToken: data.refresh_token as string,
        expiresIn: 28800,
      };
    },

    async refreshToken(refreshToken: string) {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) return null;
      const data = await response.json() as Record<string, unknown>;
      return {
        accessToken: data.access_token as string,
        refreshToken: (data.refresh_token as string) || refreshToken,
        expiresIn: (data.expires_in as number) || 28800,
      };
    },
  };
}
