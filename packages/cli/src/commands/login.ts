import { exec } from "node:child_process";
import type { AuthStorage } from "../config/auth-storage.js";

export function isLoginCancelledError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes("login cancelled") || message.includes("login aborted") || message.includes("aborted");
}

function openBrowser(url: string): void {
	const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	exec(`${openCmd} "${url}"`);
}

async function promptWithAbort(
	promptInput: (message: string) => Promise<string>,
	message: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!signal) return await promptInput(message);
	if (signal.aborted) throw new Error("Login cancelled");
	return await new Promise<string>((resolve, reject) => {
		const onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		promptInput(message).then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export async function handleLogin(
	providerId: string | undefined,
	storage: AuthStorage,
	print: (text: string) => void,
	promptInput?: (message: string) => Promise<string>,
	signal?: AbortSignal,
): Promise<void> {
	const providers = storage.getOAuthProviders();

	if (!providerId) {
		print("Available providers:");
		for (const provider of providers) {
			const status = (await storage.get(provider.id))?.type === "oauth" ? " (logged in)" : "";
			print(`  ${provider.id} - ${provider.name}${status}`);
		}
		print("\nUsage: /login <provider>");
		return;
	}

	const provider = providers.find((entry) => entry.id === providerId);
	if (!provider) {
		print(`Unknown provider: ${providerId}`);
		return;
	}

	print(`Logging in to ${provider.name}...`);

	try {
		await storage.login(providerId, {
			signal,
			onAuth: (info) => {
				print(`Open this URL to authenticate:\n${info.url}`);
				if (info.instructions) {
					print(info.instructions);
				}
				try {
					openBrowser(info.url);
					print("Opened browser for authentication.");
				} catch {
					print("Could not open browser automatically.");
				}
			},
			onPrompt: async (prompt) => {
				if (!promptInput) {
					throw new Error(prompt.message);
				}
				return await promptWithAbort(promptInput, prompt.message, signal);
			},
			onProgress: (message) => print(message),
		});
	} catch (error) {
		if (isLoginCancelledError(error)) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	print(`Logged in to ${provider.name} successfully!`);
}

export async function handleLogout(
	providerId: string | undefined,
	storage: AuthStorage,
	print: (text: string) => void,
): Promise<void> {
	if (!providerId) {
		print("Usage: /logout <provider>");
		return;
	}

	const credential = await storage.get(providerId);
	if (!credential) {
		print(`Not logged in to ${providerId}`);
		return;
	}

	await storage.logout(providerId);
	print(`Logged out of ${providerId}`);
}
