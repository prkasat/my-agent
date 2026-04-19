import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  type OAuthAuthInfo,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthPrompt,
} from "@my-agent/ai";

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

export interface OAuthCredential extends OAuthCredentials {
  type: "oauth";
}

export type Credential = ApiKeyCredential | OAuthCredential;

const AUTH_DIR = path.join(process.env.HOME || ".", ".my-agent");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");
const LOCK_FILE = AUTH_FILE + ".lock";

interface AuthFileData {
  credentials?: Record<string, Credential>;
}

export class AuthStorage {
  private readonly authFile: string;
  private readonly authDir: string;
  private readonly lockFile: string;
  private credentials = new Map<string, Credential>();
  private loaded = false;

  constructor(authFile: string = AUTH_FILE) {
    this.authFile = authFile;
    this.authDir = path.dirname(authFile);
    this.lockFile = authFile + ".lock";
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.authFile, "utf-8");
      const parsed = JSON.parse(content) as AuthFileData | Record<string, Credential>;
      const raw = "credentials" in parsed ? parsed.credentials ?? {} : parsed;
      this.credentials = new Map(Object.entries(raw));
      this.loaded = true;
    } catch {
      this.credentials = new Map();
      this.loaded = true;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private serialize(): string {
    const data: AuthFileData = {
      credentials: Object.fromEntries(this.credentials),
    };
    return JSON.stringify(data, null, 2);
  }

  private async acquireLock(retries = 10, delayMs = 100): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        await fs.mkdir(this.lockFile);
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }

    try {
      const stat = await fs.stat(this.lockFile);
      if (Date.now() - stat.mtimeMs > 30_000) {
        await fs.rmdir(this.lockFile);
        await fs.mkdir(this.lockFile);
        return true;
      }
    } catch {
      // ignore
    }

    return false;
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.rmdir(this.lockFile);
    } catch {
      // ignore
    }
  }

  private async saveUnlocked(): Promise<void> {
    await fs.mkdir(this.authDir, { recursive: true });
    await fs.writeFile(this.authFile, this.serialize(), "utf-8");
    await fs.chmod(this.authFile, 0o600);
  }

  private async save(): Promise<void> {
    const lockAcquired = await this.acquireLock();
    try {
      await this.saveUnlocked();
    } finally {
      if (lockAcquired) await this.releaseLock();
    }
  }

  async get(providerId: string): Promise<Credential | undefined> {
    await this.ensureLoaded();
    return this.credentials.get(providerId);
  }

  async set(providerId: string, credential: Credential): Promise<void> {
    await this.ensureLoaded();
    this.credentials.set(providerId, credential);
    await this.save();
  }

  async remove(providerId: string): Promise<void> {
    await this.ensureLoaded();
    this.credentials.delete(providerId);
    await this.save();
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    await this.set(providerId, { type: "api_key", key });
  }

  async listProviders(): Promise<string[]> {
    await this.ensureLoaded();
    return [...this.credentials.keys()];
  }

  hasOpenRouterEnvKey(): boolean {
    return typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.length > 0;
  }

  async hasAuth(providerId: string): Promise<boolean> {
    await this.ensureLoaded();
    if (providerId === "openrouter") {
      return this.credentials.has(providerId) || this.hasOpenRouterEnvKey();
    }
    return this.credentials.has(providerId);
  }

  async login(
    providerId: string,
    callbacks: {
      onAuth: (info: OAuthAuthInfo) => void;
      onPrompt: (prompt: OAuthPrompt) => Promise<string>;
      onProgress?: (message: string) => void;
      onManualCodeInput?: () => Promise<string>;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    await this.ensureLoaded();
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const credentials = await provider.login(callbacks as OAuthLoginCallbacks);
    this.credentials.set(providerId, { type: "oauth", ...credentials });
    await this.save();
  }

  async logout(providerId: string): Promise<void> {
    await this.remove(providerId);
  }

  private isExpired(credentials: OAuthCredential): boolean {
    return Date.now() >= credentials.expiresAt - 5 * 60 * 1000;
  }

  async resolveApiKey(providerId: string): Promise<string | undefined> {
    await this.ensureLoaded();

    const stored = this.credentials.get(providerId);

    if (stored?.type === "api_key") {
      return stored.key;
    }

    if (stored?.type === "oauth") {
      if (!this.isExpired(stored)) {
        const provider = getOAuthProvider(providerId);
        return provider?.getApiKey(stored);
      }

      return await this.refreshOAuthCredentialWithLock(providerId);
    }

    if (providerId === "openrouter") {
      return process.env.OPENROUTER_API_KEY;
    }

    return undefined;
  }

  private async refreshOAuthCredentialWithLock(providerId: string): Promise<string | undefined> {
    const lockAcquired = await this.acquireLock();
    try {
      await this.load();
      const latest = this.credentials.get(providerId);
      if (!latest || latest.type !== "oauth") {
        return undefined;
      }

      if (!this.isExpired(latest)) {
        const provider = getOAuthProvider(providerId);
        return provider?.getApiKey(latest);
      }

      const oauthCreds: Record<string, OAuthCredentials> = {};
      for (const [id, credential] of this.credentials.entries()) {
        if (credential.type === "oauth") {
          oauthCreds[id] = credential;
        }
      }

      const refreshed = await getOAuthApiKey(providerId, oauthCreds);
      if (!refreshed) {
        return undefined;
      }

      this.credentials.set(providerId, { type: "oauth", ...refreshed.newCredentials });
      await this.saveUnlocked();
      return refreshed.apiKey;
    } finally {
      if (lockAcquired) await this.releaseLock();
    }
  }

  getOAuthProviders() {
    return getOAuthProviders();
  }
}
