import { Type } from "@sinclair/typebox";

export default {
	metadata: {
		id: "tool-only-example",
		name: "Tool Only Example",
		version: "1.0.0",
	},
	activate(ctx) {
		ctx.registerTool({
			name: "echo_json",
			description: "Echo structured JSON back to the model",
			parameters: Type.Object({ value: Type.Any() }),
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: JSON.stringify(params.value, null, 2) }],
				};
			},
		});
	},
};
