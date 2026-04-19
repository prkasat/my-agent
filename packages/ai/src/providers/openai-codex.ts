import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
  Usage,
} from "../types.js";
import { EventStream } from "../utils/event-stream.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

interface RequestBody {
  model: string;
  store: boolean;
  stream: boolean;
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  include?: string[];
  reasoning?: { effort?: string; summary?: string };
}

function resolveBaseUrl(baseUrl = DEFAULT_BASE_URL): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf-8")) as {
      [JWT_CLAIM_PATH]?: { chatgpt_account_id?: string };
    };
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) throw new Error("Missing account id");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from OpenAI Codex token");
  }
}

function mapThinkingLevel(level: StreamOptions["thinkingLevel"]): string | undefined {
  if (!level || level === "minimal") return "minimal";
  if (level === "low") return "low";
  if (level === "medium") return "medium";
  return "high";
}

function convertMessages(context: Context): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: [{ type: "input_text", text: msg.content }] });
        continue;
      }

      messages.push({
        role: "user",
        content: msg.content.map((block) =>
          block.type === "text"
            ? { type: "input_text", text: block.text }
            : { type: "input_image", detail: "auto", image_url: `data:${block.mimeType};base64,${block.data}` },
        ),
      });
      continue;
    }

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          messages.push({
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
          });
        } else if (block.type === "tool_call") {
          messages.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: block.arguments,
          });
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const textOutput = msg.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      messages.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: textOutput || "(no output)",
      });
    }
  }

  return messages;
}

function convertTools(context: Context): Array<Record<string, unknown>> | undefined {
  if (!context.tools?.length) return undefined;
  return context.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function buildRequestBody(model: Model, context: Context, options: StreamOptions = {}): RequestBody {
  const body: RequestBody = {
    model: model.id,
    store: false,
    stream: true,
    input: convertMessages(context),
  };

  if (context.systemPrompt) {
    body.instructions = context.systemPrompt;
  }

  const tools = convertTools(context);
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }

  const effort = mapThinkingLevel(options.thinkingLevel);
  if (effort) {
    body.reasoning = { effort, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  return body;
}

function mapStopReason(status: string | undefined, hasToolCalls: boolean): AssistantMessage["stopReason"] {
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  if (hasToolCalls) return "toolUse";
  return "stop";
}

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data) as Record<string, unknown>;
            } catch {
              // ignore malformed chunks
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

export function createOpenAICodexStream(config?: { baseUrl?: string; providerName?: string }) {
  return function openAICodexStream(
    model: Model,
    context: Context,
    options: StreamOptions = {},
  ): EventStream<AssistantMessageEvent, AssistantMessage> {
    const providerName = config?.providerName ?? "openai-codex";
    const eventStream = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        throw new Error((event as { error?: string }).error || "OpenAI Codex stream error");
      },
    );

    void (async () => {
      const body = buildRequestBody(model, context, options);
      const content: AssistantMessage["content"] = [];
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopStatus: string | undefined;
      let currentThinking = "";
      let currentText = "";
      let currentToolCall: { id: string; name: string; arguments: string } | null = null;

      eventStream.push({ type: "start", message: { role: "assistant", content: [] } });

      try {
        const apiKey = options.apiKey;
        if (!apiKey) {
          eventStream.push({ type: "error", error: "OpenAI Codex requires OAuth login via /login openai-codex" });
          return;
        }

        const response = await fetch(resolveBaseUrl(config?.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "chatgpt-account-id": extractAccountId(apiKey),
            originator: "my-agent",
            "OpenAI-Beta": "responses=experimental",
            accept: "text/event-stream",
            "content-type": "application/json",
            "User-Agent": "my-agent",
          },
          body: JSON.stringify(body),
          signal: options.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          eventStream.push({
            type: "error",
            error: `openai-codex API ${response.status}: ${errorText || response.statusText}`,
          });
          return;
        }

        for await (const event of parseSSE(response)) {
          const type = typeof event.type === "string" ? event.type : "";
          if (!type) continue;

          if (type === "error") {
            throw new Error(String(event.message ?? event.code ?? "Unknown Codex error"));
          }

          if (type === "response.failed") {
            const responseError = (event.response as { error?: { message?: string } } | undefined)?.error?.message;
            throw new Error(responseError || "Codex response failed");
          }

          if (type === "response.output_item.added") {
            const item = event.item as { type?: string; call_id?: string; id?: string; name?: string } | undefined;
            if (!item?.type) continue;

            if (item.type === "reasoning") {
              currentThinking = "";
            } else if (item.type === "message") {
              currentText = "";
            } else if (item.type === "function_call") {
              currentToolCall = {
                id: String(item.call_id ?? item.id ?? ""),
                name: String(item.name ?? ""),
                arguments: "",
              };
              eventStream.push({
                type: "tool_call_start",
                id: currentToolCall.id,
                name: currentToolCall.name,
              });
            }
            continue;
          }

          if (type === "response.reasoning_summary_text.delta") {
            const delta = String(event.delta ?? "");
            if (delta) {
              currentThinking += delta;
              eventStream.push({ type: "thinking_delta", text: delta });
            }
            continue;
          }

          if (type === "response.output_text.delta" || type === "response.refusal.delta") {
            const delta = String(event.delta ?? "");
            if (delta) {
              currentText += delta;
              eventStream.push({ type: "text_delta", text: delta });
            }
            continue;
          }

          if (type === "response.function_call_arguments.delta") {
            if (!currentToolCall) continue;
            const delta = String(event.delta ?? "");
            currentToolCall.arguments += delta;
            eventStream.push({ type: "tool_call_delta", id: currentToolCall.id, arguments: delta });
            continue;
          }

          if (type === "response.function_call_arguments.done") {
            if (!currentToolCall) continue;
            currentToolCall.arguments = String(event.arguments ?? currentToolCall.arguments);
            continue;
          }

          if (type === "response.output_item.done") {
            const item = event.item as {
              type?: string;
              summary?: Array<{ text?: string }>;
              content?: Array<{ type?: string; text?: string; refusal?: string }>;
              call_id?: string;
              id?: string;
              name?: string;
              arguments?: string;
            } | undefined;
            if (!item?.type) continue;

            if (item.type === "reasoning") {
              const text = item.summary?.map((part) => part.text || "").join("\n\n") || currentThinking;
              if (text) {
                content.push({ type: "thinking", text });
              }
              currentThinking = "";
              continue;
            }

            if (item.type === "message") {
              const text = item.content
                ?.filter((part) => part.type === "output_text" || part.type === "refusal")
                .map((part) => part.text || part.refusal || "")
                .join("") || currentText;
              if (text) {
                content.push({ type: "text", text });
              }
              currentText = "";
              continue;
            }

            if (item.type === "function_call") {
              const finalized = currentToolCall ?? {
                id: String(item.call_id ?? item.id ?? ""),
                name: String(item.name ?? ""),
                arguments: String(item.arguments ?? "{}"),
              };
              if (!finalized.arguments) {
                finalized.arguments = String(item.arguments ?? "{}");
              }
              content.push({
                type: "tool_call",
                id: finalized.id,
                name: finalized.name,
                arguments: finalized.arguments,
              });
              eventStream.push({ type: "tool_call_end", id: finalized.id });
              currentToolCall = null;
            }
            continue;
          }

          if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
            const responseData = event.response as {
              status?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
              };
            } | undefined;
            stopStatus = responseData?.status;
            usage = {
              inputTokens: (responseData?.usage?.input_tokens || 0) - (responseData?.usage?.input_tokens_details?.cached_tokens || 0),
              outputTokens: responseData?.usage?.output_tokens || 0,
              ...(responseData?.usage?.input_tokens_details?.cached_tokens
                ? { cacheReadTokens: responseData.usage.input_tokens_details.cached_tokens }
                : {}),
            };
            break;
          }
        }

        const message: AssistantMessage = {
          role: "assistant",
          content,
          model: model.id,
          provider: providerName,
          usage,
          stopReason: mapStopReason(stopStatus, content.some((block) => block.type === "tool_call")),
          timestamp: Date.now(),
        };

        eventStream.push({ type: "done", message });
      } catch (error) {
        if (options.signal?.aborted) {
          eventStream.end();
          return;
        }
        eventStream.push({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return eventStream;
  };
}
