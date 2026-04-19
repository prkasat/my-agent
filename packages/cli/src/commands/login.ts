import { createServer } from "node:http";
import { exec } from "node:child_process";
import { getOAuthProviders, type OAuthProvider, type LoginResult } from "@my-agent/ai";
import type { OAuthStorage } from "../config/oauth-storage.js";

export async function handleLogin(
  providerId: string | undefined,
  storage: OAuthStorage,
  print: (text: string) => void,
): Promise<void> {
  const providers = getOAuthProviders();

  if (!providerId) {
    print("Available providers:");
    for (const p of providers) {
      const status = (await storage.get(p.id)) ? " (logged in)" : "";
      print(`  ${p.id} - ${p.name}${status}`);
    }
    print("\nUsage: /login <provider>");
    return;
  }

  const provider = providers.find(p => p.id === providerId);
  if (!provider) {
    print(`Unknown provider: ${providerId}`);
    return;
  }

  print(`Logging in to ${provider.name}...`);

  const result = await provider.startLogin();

  if (result.type === "browser") {
    await handleBrowserFlow(provider, result, storage, print);
  } else if (result.type === "device") {
    await handleDeviceFlow(provider, result, storage, print);
  }
}

async function handleBrowserFlow(
  provider: OAuthProvider,
  result: LoginResult,
  storage: OAuthStorage,
  print: (text: string) => void,
): Promise<void> {
  print(`Opening browser for authentication...`);
  print(`If browser doesn't open, visit: ${result.authUrl}`);

  const openCmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${result.authUrl}"`);

  const code = await waitForCallback(9876);
  if (!code) {
    print("Login failed: no authorization code received.");
    return;
  }

  if (!provider.exchangeCode) {
    print("Login failed: provider does not support code exchange.");
    return;
  }

  const tokens = await provider.exchangeCode(code);
  await storage.set(provider.id, {
    type: "oauth",
    providerId: provider.id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: Date.now() + (tokens.expiresIn * 1000),
    scopes: tokens.scopes,
  });

  print(`Logged in to ${provider.name} successfully!`);
}

async function handleDeviceFlow(
  provider: OAuthProvider,
  result: LoginResult,
  storage: OAuthStorage,
  print: (text: string) => void,
): Promise<void> {
  print(`\nGo to: ${result.verificationUrl}`);
  print(`Enter code: ${result.userCode}\n`);
  print(`Waiting for authorization...`);

  if (!provider.pollDeviceAuth || !result.deviceCode) {
    print("Login failed: provider does not support device flow.");
    return;
  }

  const interval = (result.pollInterval || 5) * 1000;
  const MAX_POLL_ATTEMPTS = 60;
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    await new Promise(r => setTimeout(r, interval));
    const tokens = await provider.pollDeviceAuth(result.deviceCode);
    if (tokens) {
      process.stderr.write("\n");
      await storage.set(provider.id, {
        type: "oauth",
        providerId: provider.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || "",
        expiresAt: Date.now() + (tokens.expiresIn * 1000),
      });
      print(`Logged in to ${provider.name} successfully!`);
      return;
    }
    process.stderr.write(`\rWaiting for authorization... (${attempts}/${MAX_POLL_ATTEMPTS})`);
  }

  throw new Error("Device authorization timed out after 5 minutes. Please try again.");
}

function waitForCallback(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${port}`);
      const code = url.searchParams.get("code");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Login successful!</h1><p>You can close this window.</p>");

      server.close();
      resolve(code);
    });

    server.listen(port);

    setTimeout(() => {
      server.close();
      resolve(null);
    }, 5 * 60 * 1000);
  });
}

export async function handleLogout(
  providerId: string | undefined,
  storage: OAuthStorage,
  print: (text: string) => void,
): Promise<void> {
  if (!providerId) {
    print("Usage: /logout <provider>");
    return;
  }

  const cred = await storage.get(providerId);
  if (!cred) {
    print(`Not logged in to ${providerId}`);
    return;
  }

  await storage.remove(providerId);
  print(`Logged out of ${providerId}`);
}
