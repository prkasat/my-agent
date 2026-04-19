export default {
	metadata: {
		id: "middleware-example",
		name: "Middleware Example",
		version: "1.0.0",
	},
	activate(ctx) {
		ctx.on("tool_execution_start", (event) => {
			if (event.toolName === "bash" && typeof event.args === "object" && event.args && "command" in event.args) {
				const command = String(event.args.command || "");
				if (command.includes("rm -rf")) {
					return { action: "block", reason: "Blocked destructive command in middleware example." };
				}
			}
		});
	},
};
