export default {
	metadata: {
		id: "non-coding-workflow-example",
		name: "Non-coding Workflow Example",
		version: "1.0.0",
	},
	activate(ctx) {
		ctx.registerCommand({
			name: "review-report",
			description: "Generate a review/report prompt for arbitrary notes",
			execute(args) {
				ctx.actions.sendMessage(
					`Review the following notes and produce a decision memo with risks, assumptions, and recommendation:\n\n${args}`,
				);
			},
		});
	},
};
