export default {
	metadata: {
		id: "command-only-example",
		name: "Command Only Example",
		version: "1.0.0",
	},
	activate(ctx) {
		ctx.registerCommand({
			name: "summarize-ticket",
			description: "Turn a ticket id into a structured prompt",
			execute(args) {
				ctx.actions.sendMessage(`Summarize ticket ${args}. Include impact, risk, owner, and next step.`);
			},
		});
	},
};
