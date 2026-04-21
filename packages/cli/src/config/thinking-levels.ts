export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function getNextThinkingLevel(current: string, direction: 1 | -1 = 1): ThinkingLevel {
	const currentIndex = THINKING_LEVELS.indexOf(isThinkingLevel(current) ? current : "medium");
	const nextIndex = (currentIndex + direction + THINKING_LEVELS.length) % THINKING_LEVELS.length;
	return THINKING_LEVELS[nextIndex] ?? "medium";
}

export function getThinkingLevelDescription(level: ThinkingLevel): string {
	switch (level) {
		case "off":
			return "Disable extra thinking";
		case "minimal":
			return "Fastest, lightest thinking";
		case "low":
			return "Low thinking level";
		case "medium":
			return "Balanced default thinking level";
		case "high":
			return "Higher thinking level for harder tasks";
		case "xhigh":
			return "Maximum thinking level";
	}
}
