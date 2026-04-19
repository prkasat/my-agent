import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * OAuth credential storage with file locking.
 *
 * File locking prevents race conditions when multiple agent instances
 * try to refresh the same token simultaneously.
 */

export interface OAuthCredential {
  type: "oauth";
  providerId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
}

export interface ApiKeyCredential {
  type: "api_key";
  providerId: string;
  key: string;
}

export type Credential = OAuthCredential | ApiKeyCredential;

const AUTH_DIR = path.join(process.env.HOME || ".", ".my-agent");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");
const LOCK_FILE = AUTH_FILE + ".lock";

interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

type RefreshFn = (providerId: string, refreshToken: string) => Promise<RefreshResult | null>;

export class OAuthStorage {
  private credentials: Map<string, Credential> = new Map();
  private loaded = false;
  private refreshFn?: RefreshFn;

  constructor(refreshFn?: RefreshFn) {
    this.refreshFn = refreshFn;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(AUTH_FILE, "utf-8");
      const data = JSON.parse(content);
      for (const [id, cred] of Object.entries(data.credentials || {})) {
        this.credentials.set(id, cred as Credential);
      }
      this.loaded = true;
    } catch {
      this.loaded = true;
    }
  }

  private async save(): Promise<void> {
    const lockAcquired = await this.acquireLock();
    try {
      await this.saveUnlocked();
    } finally {
      if (lockAcquired) await this.releaseLock();
    }
  }

  /** Write credentials to disk. Caller must hold the lock. */
  private async saveUnlocked(): Promise<void> {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    const data = {
      credentials: Object.fromEntries(this.credentials),
    };
    await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2), "utf-8");
    await fs.chmod(AUTH_FILE, 0o600);
  }

  async set(providerId: string, credential: Credential): Promise<void> {
    if (!this.loaded) await this.load();
    this.credentials.set(providerId, credential);
    await this.save();
  }

  async get(providerId: string): Promise<Credential | undefined> {
    if (!this.loaded) await this.load();
    const cred = this.credentials.get(providerId);
    if (!cred) return undefined;

    if (cred.type === "oauth" && this.isExpired(cred)) {
      return await this.refreshToken(cred);
    }

    return cred;
  }

  async remove(providerId: string): Promise<void> {
    if (!this.loaded) await this.load();
    this.credentials.delete(providerId);
    await this.save();
  }

  async listProviders(): Promise<string[]> {
    if (!this.loaded) await this.load();
    return [...this.credentials.keys()];
  }

  async resolveApiKey(providerId: string): Promise<string | undefined> {
    const envMap: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
    };
    const envKey = envMap[providerId];
    if (envKey && process.env[envKey]) return process.env[envKey];

    const cred = await this.get(providerId);
    if (!cred) return undefined;

    if (cred.type === "api_key") return cred.key;
    if (cred.type === "oauth") return cred.accessToken;

    return undefined;
  }

  private isExpired(cred: OAuthCredential): boolean {
    return Date.now() > cred.expiresAt - 5 * 60 * 1000;
  }

  private async refreshToken(cred: OAuthCredential): Promise<OAuthCredential | undefined> {
    if (!this.refreshFn) return undefined;

    const lockAcquired = await this.acquireLock();
    try {
      await this.load();
      const current = this.credentials.get(cred.providerId);
      if (current?.type === "oauth" && !this.isExpired(current)) {
        return current;
      }

      const newTokens = await this.refreshFn(cred.providerId, cred.refreshToken);
      if (!newTokens) return undefined;

      const updated: OAuthCredential = {
        ...cred,
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken || cred.refreshToken,
        expiresAt: Date.now() + (newTokens.expiresIn * 1000),
      };

      this.credentials.set(cred.providerId, updated);
      await this.saveUnlocked(); // Use unlocked save since we already hold the lock
      return updated;
    } catch {
      return undefined;
    } finally {
      if (lockAcquired) await this.releaseLock();
    }
  }

  private async acquireLock(retries = 10, delayMs = 100): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        await fs.mkdir(LOCK_FILE);
        return true;
      } catch {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      }
    }
    try {
      const stat = await fs.stat(LOCK_FILE);
      if (Date.now() - stat.mtimeMs > 30000) {
        await fs.rmdir(LOCK_FILE);
        await fs.mkdir(LOCK_FILE);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.rmdir(LOCK_FILE);
    } catch { /* ignore */ }
  }
}
