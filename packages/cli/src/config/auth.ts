import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Credential storage.
 *
 * Keys can come from env vars (highest priority) or from encrypted config file.
 */

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".my-agent"
);
const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");

interface AuthStore {
  keys: Record<string, string>;
}

const ENCRYPTION_KEY = crypto.createHash("sha256")
  .update(process.env.USER || "default")
  .digest();

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(text: string): string {
  const [ivHex, encHex] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}

const ENV_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

export async function getApiKey(provider: string): Promise<string | undefined> {
  const envKey = ENV_MAP[provider];
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }

  try {
    const content = await fs.readFile(AUTH_FILE, "utf-8");
    const store: AuthStore = JSON.parse(content);
    if (store.keys[provider]) {
      return decrypt(store.keys[provider]);
    }
  } catch {
    // No auth file yet
  }

  return undefined;
}

export async function setApiKey(provider: string, key: string): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  let store: AuthStore = { keys: {} };
  try {
    const content = await fs.readFile(AUTH_FILE, "utf-8");
    store = JSON.parse(content);
  } catch {
    // Fresh store
  }

  store.keys[provider] = encrypt(key);
  await fs.writeFile(AUTH_FILE, JSON.stringify(store, null, 2), "utf-8");
  await fs.chmod(AUTH_FILE, 0o600);
}

export async function removeApiKey(provider: string): Promise<void> {
  try {
    const content = await fs.readFile(AUTH_FILE, "utf-8");
    const store: AuthStore = JSON.parse(content);
    delete store.keys[provider];
    await fs.writeFile(AUTH_FILE, JSON.stringify(store, null, 2), "utf-8");
    await fs.chmod(AUTH_FILE, 0o600);
  } catch {
    // No file or key
  }
}

export async function listProviders(): Promise<string[]> {
  try {
    const content = await fs.readFile(AUTH_FILE, "utf-8");
    const store: AuthStore = JSON.parse(content);
    return Object.keys(store.keys);
  } catch {
    return [];
  }
}
