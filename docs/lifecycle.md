# Lifecycle Walkthroughs

## Agent turn lifecycle

1. receive prompt
2. resolve model against auth state
3. discover project context
4. load extensions for the run
5. let extensions transform user input
6. build tools list
7. build system prompt
8. append user message to session
9. run the agent loop
10. stream assistant/tool events
11. append assistant/tool results to session
12. flush session on completion/error/abort

## Permission lifecycle

1. model requests a tool
2. extension middleware may modify or block args
3. permission checker evaluates the tool call
4. risky calls are auto-allowed, asked, or denied based on mode
5. approved calls execute
6. tool result is persisted and shown to the user

## Auth and model lifecycle

1. settings choose a configured model
2. model registry checks current auth state
3. if unavailable, the registry explains why
4. runtime picks the configured model or a sensible authenticated fallback
5. OAuth credentials are refreshed on demand before provider calls

## Extension lifecycle

1. discover local extension entries
2. import extension modules
3. validate/activate them in the extension runner
4. dispatch lifecycle, message, tool, and session events
5. unload/dispose after the run or during hot reload

## RPC lifecycle

1. host sends JSONL command
2. server validates and acknowledges it
3. prompt execution emits structured events
4. host may abort the active request
5. host may query state or list models
