import { Type } from "@sinclair/typebox";

export default {
	metadata: {
		id: "starter-extension",
		name: "Starter Extension",
		version: "1.0.0",
		apiVersion: "^1.0.0",
		description: "Minimal starter showing command, tool, and middleware hooks.",
	},
	config: {
		schema: Type.Object({
			label: Type.String({ default: "starter" }),
		}),
		defaults: { label: "starter" },
	},
	activate(ctx) {
		ctx.registerCommand({
			name: "starter",
			description: "Send a starter prompt into the agent runtime",
			execute(args) {
				ctx.actions.sendMessage(`[${ctx.config.label}] ${args || "Hello from starter extension"}`);
			},
		});

		ctx.registerTool({
			name: "starter_echo",
			description: "Echo a value back to the agent",
			parameters: Type.Object({ value: Type.String() }),
			async execute(_id, params) {
				return { content: [{ type: "text", text: `[${ctx.config.label}] ${params.value}` }] };
			},
		});

		ctx.on("tool_execution_start", (event) => {
			if (event.toolName === "starter_echo") {
				ctx.log.info("starter_echo invoked", event.args);
			}
		});
	},
};
