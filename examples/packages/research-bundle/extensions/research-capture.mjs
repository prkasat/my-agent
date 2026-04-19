export default {
	metadata: {
		id: "research-capture",
		name: "Research Capture",
		version: "1.0.0",
		description: "Command-only extension that turns loose notes into a structured prompt.",
	},
	activate(ctx) {
		ctx.registerCommand({
			name: "capture-note",
			description: "Convert quick notes into a structured follow-up prompt",
			execute(args) {
				ctx.actions.sendMessage(`Turn these raw notes into a structured research memo with actions:\n\n${args}`);
				ctx.ui.notify("Queued research memo prompt", "info");
			},
		});
	},
};
