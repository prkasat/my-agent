/**
 * OAuth provider registry and built-in providers.
 *
 * Providers own their full login flow so the CLI can stay thin and the
 * auth storage can treat API-key and OAuth-backed providers uniformly.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export interface OAuthCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scopes?: string[];
	[key: string]: unknown;
}

export interface OAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
}

export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

export interface OAuthLoginCallbacks {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
}

export interface OAuthProvider {
	id: string;
	name: string;
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
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

export async function getOAuthApiKey(
	providerId: string,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);

	let current = credentials[providerId];
	if (!current) return null;

	if (Date.now() >= current.expiresAt) {
		current = await provider.refreshToken(current);
	}

	return {
		apiKey: provider.getApiKey(current),
		newCredentials: current,
	};
}

function createState(): string {
	return randomBytes(16).toString("hex");
}

function base64UrlEncode(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64UrlEncode(randomBytes(32));
	const digest = createHash("sha256").update(verifier).digest();
	return { verifier, challenge: base64UrlEncode(digest) };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// ignore
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code: code || undefined, state: state || undefined };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64url").toString("utf-8");
		return JSON.parse(decoded) as Record<string, unknown>;
	} catch {
		return null;
	}
}

interface CallbackServerInfo {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
}

async function startLocalCallbackServer(options: {
	port: number;
	path: string;
	expectedState?: string;
	successHtml?: string;
	errorHtml?: (message: string) => string;
}): Promise<CallbackServerInfo> {
	const successHtml = options.successHtml ?? "<h1>Login successful!</h1><p>You can close this window.</p>";
	const errorHtml = options.errorHtml ?? ((message: string) => `<h1>Login failed</h1><p>${escapeHtml(message)}</p>`);

	let settleWait: ((value: { code: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url || "", `http://localhost:${options.port}`);
			if (url.pathname !== options.path) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(errorHtml("Callback route not found."));
				return;
			}
			if (options.expectedState && url.searchParams.get("state") !== options.expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(errorHtml("State mismatch."));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(errorHtml("Missing authorization code."));
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(successHtml);
			settleWait?.({ code });
		} catch {
			res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
			res.end(errorHtml("Internal error while processing OAuth callback."));
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		close: () => server.close(),
		cancelWait: () => settleWait?.(null),
		waitForCode: () => waitForCodePromise,
	};
}

async function waitForAuthorizationCode(
	callbacks: OAuthLoginCallbacks,
	server: CallbackServerInfo | null,
	fallbackPrompt: OAuthPrompt,
	expectedState?: string,
): Promise<string> {
	const onAbort = () => {
		server?.cancelWait();
	};
	callbacks.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		let code: string | undefined;
		let manualInput: string | undefined;
		let manualError: Error | undefined;

		const manualPromise = callbacks.onManualCodeInput
			? callbacks
					.onManualCodeInput()
					.then((input) => {
						manualInput = input;
						server?.cancelWait();
					})
					.catch((err) => {
						manualError = err instanceof Error ? err : new Error(String(err));
						server?.cancelWait();
					})
			: undefined;

		const callbackResult = server ? await server.waitForCode() : null;

		if (manualError) throw manualError;
		if (callbackResult?.code) {
			code = callbackResult.code;
		} else if (manualInput) {
			const parsed = parseAuthorizationInput(manualInput);
			if (expectedState && parsed.state && parsed.state !== expectedState) {
				throw new Error("State mismatch");
			}
			code = parsed.code;
		}

		if (!code && manualPromise) {
			await manualPromise;
			if (manualError) throw manualError;
			if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (expectedState && parsed.state && parsed.state !== expectedState) {
					throw new Error("State mismatch");
				}
				code = parsed.code;
			}
		}

		if (!code) {
			const input = await callbacks.onPrompt(fallbackPrompt);
			const parsed = parseAuthorizationInput(input);
			if (expectedState && parsed.state && parsed.state !== expectedState) {
				throw new Error("State mismatch");
			}
			code = parsed.code;
		}

		if (callbacks.signal?.aborted) {
			throw new Error("Login aborted");
		}

		if (!code) throw new Error("Missing authorization code");
		return code;
	} finally {
		callbacks.signal?.removeEventListener("abort", onAbort);
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const DEFAULT_ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_REDIRECT_URI = "http://localhost:9876/callback";

export function createAnthropicOAuthProvider(clientId: string = DEFAULT_ANTHROPIC_CLIENT_ID): OAuthProvider {
	return {
		id: "anthropic",
		name: "Anthropic (Claude Pro/Max)",
		usesCallbackServer: true,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const state = createState();
			const params = new URLSearchParams({
				client_id: clientId,
				redirect_uri: ANTHROPIC_REDIRECT_URI,
				response_type: "code",
				scope: "messages:write",
				state,
			});

			const server = await startLocalCallbackServer({
				port: 9876,
				path: "/callback",
				expectedState: state,
			});

			try {
				callbacks.onAuth({
					url: `https://console.anthropic.com/oauth/authorize?${params}`,
					instructions: "Complete the login in your browser. If the callback fails, paste the full redirect URL.",
				});

				const code = await waitForAuthorizationCode(
					callbacks,
					server,
					{ message: "Paste the Anthropic redirect URL (or authorization code):" },
					state,
				);

				const response = await fetch("https://console.anthropic.com/oauth/token", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						grant_type: "authorization_code",
						client_id: clientId,
						redirect_uri: ANTHROPIC_REDIRECT_URI,
						code,
					}),
					signal: callbacks.signal,
				});

				if (!response.ok) {
					throw new Error(`Anthropic token exchange failed: ${response.status}`);
				}

				const data = (await response.json()) as Record<string, unknown>;
				return {
					accessToken: String(data.access_token ?? ""),
					refreshToken: String(data.refresh_token ?? ""),
					expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
					scopes: Array.isArray(data.scope) ? (data.scope as string[]) : undefined,
				};
			} finally {
				server.close();
			}
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			const response = await fetch("https://console.anthropic.com/oauth/token", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					grant_type: "refresh_token",
					client_id: clientId,
					refresh_token: credentials.refreshToken,
				}),
			});

			if (!response.ok) {
				throw new Error(`Anthropic token refresh failed: ${response.status}`);
			}

			const data = (await response.json()) as Record<string, unknown>;
			return {
				...credentials,
				accessToken: String(data.access_token ?? ""),
				refreshToken: String(data.refresh_token ?? credentials.refreshToken),
				expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
				scopes: Array.isArray(data.scope) ? (data.scope as string[]) : credentials.scopes,
			};
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.accessToken;
		},
	};
}

export function createGitHubCopilotOAuthProvider(clientId: string): OAuthProvider {
	return {
		id: "github-copilot",
		name: "GitHub Copilot",

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const response = await fetch("https://github.com/login/device/code", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({ client_id: clientId, scope: "copilot" }),
				signal: callbacks.signal,
			});

			if (!response.ok) {
				throw new Error(`GitHub device authorization failed: ${response.status}`);
			}

			const data = (await response.json()) as Record<string, unknown>;
			const verificationUrl = String(data.verification_uri ?? "https://github.com/login/device");
			const userCode = String(data.user_code ?? "");
			const deviceCode = String(data.device_code ?? "");
			const intervalSeconds = Number(data.interval ?? 5);

			callbacks.onAuth({
				url: verificationUrl,
				instructions: `Open the URL and enter code: ${userCode}`,
			});

			while (!callbacks.signal?.aborted) {
				await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));

				const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify({
						client_id: clientId,
						device_code: deviceCode,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					}),
					signal: callbacks.signal,
				});

				const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
				if (tokenData.error === "authorization_pending") continue;
				if (tokenData.error) {
					throw new Error(String(tokenData.error_description ?? tokenData.error));
				}

				return {
					accessToken: String(tokenData.access_token ?? ""),
					refreshToken: String(tokenData.refresh_token ?? ""),
					expiresAt: Date.now() + Number(tokenData.expires_in ?? 28800) * 1000,
				};
			}

			throw new Error("GitHub Copilot login aborted");
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			const response = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					client_id: clientId,
					grant_type: "refresh_token",
					refresh_token: credentials.refreshToken,
				}),
			});

			if (!response.ok) {
				throw new Error(`GitHub Copilot token refresh failed: ${response.status}`);
			}

			const data = (await response.json()) as Record<string, unknown>;
			return {
				...credentials,
				accessToken: String(data.access_token ?? ""),
				refreshToken: String(data.refresh_token ?? credentials.refreshToken),
				expiresAt: Date.now() + Number(data.expires_in ?? 28800) * 1000,
			};
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.accessToken;
		},
	};
}

const DEFAULT_OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

function extractOpenAICodexAccountId(accessToken: string): string {
	const payload = decodeJwtPayload(accessToken);
	const auth = payload?.[OPENAI_CODEX_JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("Failed to extract accountId from OpenAI token");
	}
	return accountId;
}

export function createOpenAICodexOAuthProvider(
	clientId: string = process.env.OPENAI_CODEX_OAUTH_CLIENT_ID || DEFAULT_OPENAI_CODEX_CLIENT_ID,
): OAuthProvider {
	return {
		id: "openai-codex",
		name: "ChatGPT Plus/Pro (Codex Subscription)",
		usesCallbackServer: true,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const { verifier, challenge } = await generatePKCE();
			const state = createState();
			const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
			url.searchParams.set("response_type", "code");
			url.searchParams.set("client_id", clientId);
			url.searchParams.set("redirect_uri", OPENAI_CODEX_REDIRECT_URI);
			url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
			url.searchParams.set("code_challenge", challenge);
			url.searchParams.set("code_challenge_method", "S256");
			url.searchParams.set("state", state);
			url.searchParams.set("id_token_add_organizations", "true");
			url.searchParams.set("codex_cli_simplified_flow", "true");
			url.searchParams.set("originator", "my-agent");

			const server = await startLocalCallbackServer({
				port: 1455,
				path: "/auth/callback",
				expectedState: state,
			});

			try {
				callbacks.onAuth({
					url: url.toString(),
					instructions:
						"Complete the OpenAI login in your browser. If the callback fails, paste the full redirect URL.",
				});

				const code = await waitForAuthorizationCode(
					callbacks,
					server,
					{ message: "Paste the OpenAI redirect URL (or authorization code):" },
					state,
				);

				const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						client_id: clientId,
						code,
						code_verifier: verifier,
						redirect_uri: OPENAI_CODEX_REDIRECT_URI,
					}),
					signal: callbacks.signal,
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new Error(`OpenAI token exchange failed: ${response.status}${errorText ? ` ${errorText}` : ""}`);
				}

				const data = (await response.json()) as Record<string, unknown>;
				const accessToken = String(data.access_token ?? "");
				return {
					accessToken,
					refreshToken: String(data.refresh_token ?? ""),
					expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
					accountId: extractOpenAICodexAccountId(accessToken),
				};
			} finally {
				server.close();
			}
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: credentials.refreshToken,
					client_id: clientId,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				throw new Error(`OpenAI token refresh failed: ${response.status}${errorText ? ` ${errorText}` : ""}`);
			}

			const data = (await response.json()) as Record<string, unknown>;
			const accessToken = String(data.access_token ?? "");
			return {
				...credentials,
				accessToken,
				refreshToken: String(data.refresh_token ?? credentials.refreshToken),
				expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
				accountId: extractOpenAICodexAccountId(accessToken),
			};
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.accessToken;
		},
	};
}

/**
 * Register built-in OAuth providers.
 *
 * Anthropic requires an app-specific client id, so it is only registered
 * when provided explicitly or through ANTHROPIC_OAUTH_CLIENT_ID.
 * OpenAI Codex uses the public Codex OAuth client id unless overridden.
 */
export function registerBuiltinOAuthProviders(config?: {
	anthropicClientId?: string;
	githubCopilotClientId?: string;
	openAICodexClientId?: string;
}): void {
	const anthropicClientId =
		config?.anthropicClientId || process.env.ANTHROPIC_OAUTH_CLIENT_ID || DEFAULT_ANTHROPIC_CLIENT_ID;
	const githubClientId = config?.githubCopilotClientId || process.env.GITHUB_COPILOT_CLIENT_ID;
	const openAICodexClientId = config?.openAICodexClientId || process.env.OPENAI_CODEX_OAUTH_CLIENT_ID;

	registerOAuthProvider(createAnthropicOAuthProvider(anthropicClientId));
	registerOAuthProvider(createOpenAICodexOAuthProvider(openAICodexClientId || DEFAULT_OPENAI_CODEX_CLIENT_ID));

	if (githubClientId) {
		registerOAuthProvider(createGitHubCopilotOAuthProvider(githubClientId));
	}
}
