/**
 * SessionSelector - Overlay for selecting and managing sessions
 */

import {
	SelectList,
	type SelectItem,
	type SelectListTheme,
	type OverlayHandle,
	type TUI,
} from "@mariozechner/pi-tui";

export interface SessionInfo {
	/** Session identifier */
	id: string;
	/** Session name/title */
	name: string;
	/** When the session was created */
	createdAt: Date;
	/** When the session was last active */
	lastActiveAt: Date;
	/** Number of messages in the session */
	messageCount: number;
	/** Optional description or first message preview */
	preview?: string;
	/** Whether this is the current active session */
	isActive?: boolean;
}

/**
 * Discriminated union for session selector result
 */
export type SessionSelectorResult =
	| { kind: "new" }
	| { kind: "existing"; session: SessionInfo };

export interface SessionSelectorOptions {
	/** Theme for the select list */
	theme: SelectListTheme;
	/** Maximum visible items (default: 10) */
	maxVisible?: number;
	/** Callback when a selection is made */
	onSelect?: (result: SessionSelectorResult) => void;
	/** Callback when selector is cancelled */
	onCancel?: () => void;
	/** Whether to show "New Session" option (default: true) */
	showNewSession?: boolean;
}

// Internal sentinel value - uses a format unlikely to collide with real session IDs
const NEW_SESSION_VALUE = "\0__new_session__";

/**
 * Creates a session selector overlay.
 *
 * @throws {Error} If no items would be shown (empty sessions with showNewSession=false)
 * @throws {Error} If a session ID matches the internal sentinel value (extremely unlikely)
 *
 * @example
 * ```typescript
 * const selector = createSessionSelector(tui, sessions, {
 *   theme: selectListTheme,
 *   onSelect: (result) => {
 *     if (result.kind === "new") {
 *       // Create new session
 *     } else {
 *       // Load existing session
 *       console.log(result.session.id);
 *     }
 *   },
 * });
 * ```
 */
export function createSessionSelector(
	tui: TUI,
	sessions: SessionInfo[],
	options: SessionSelectorOptions
): OverlayHandle {
	const showNew = options.showNewSession ?? true;
	const items: SelectItem[] = [];

	// Check for collision with internal sentinel value
	const collidingSession = sessions.find((s) => s.id === NEW_SESSION_VALUE);
	if (collidingSession) {
		throw new Error(`SessionSelector: session ID "${collidingSession.id}" collides with internal sentinel`);
	}

	// Add "New Session" option at the top
	if (showNew) {
		items.push({
			value: NEW_SESSION_VALUE,
			label: "+ New Session",
			description: "Start a new conversation",
		});
	}

	// Add existing sessions, sorted by last active
	const sortedSessions = [...sessions].sort(
		(a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime()
	);

	for (const session of sortedSessions) {
		items.push({
			value: session.id,
			label: formatSessionLabel(session),
			description: session.preview || formatSessionMeta(session),
		});
	}

	// Guard against empty item list which would cause undefined behavior
	if (items.length === 0) {
		throw new Error("SessionSelector requires at least one item. Enable showNewSession or provide sessions.");
	}

	const selectList = new SelectList(
		items,
		options.maxVisible ?? 10,
		options.theme,
		{
			minPrimaryColumnWidth: 25,
			maxPrimaryColumnWidth: 50,
		}
	);

	// Select the active session by default (or first item if new session option present)
	const activeIndex = items.findIndex((item) => {
		if (item.value === NEW_SESSION_VALUE) return false;
		const session = sessions.find((s) => s.id === item.value);
		return session?.isActive;
	});
	if (activeIndex >= 0) {
		selectList.setSelectedIndex(activeIndex);
	}

	const overlay = tui.showOverlay(selectList, {
		anchor: "center",
		width: "70%",
		maxHeight: "60%",
	});

	selectList.onSelect = (item: SelectItem) => {
		overlay.hide();

		if (item.value === NEW_SESSION_VALUE) {
			options.onSelect?.({ kind: "new" });
		} else {
			const session = sessions.find((s) => s.id === item.value);
			if (session) {
				options.onSelect?.({ kind: "existing", session });
			}
		}
	};

	selectList.onCancel = () => {
		overlay.hide();
		options.onCancel?.();
	};

	return overlay;
}

function formatSessionLabel(session: SessionInfo): string {
	const activeMarker = session.isActive ? "* " : "";
	return `${activeMarker}${session.name}`;
}

function formatSessionMeta(session: SessionInfo): string {
	const date = formatRelativeDate(session.lastActiveAt);
	return `${session.messageCount} messages - ${date}`;
}

function formatRelativeDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / (1000 * 60));
	const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;

	return date.toLocaleDateString();
}
