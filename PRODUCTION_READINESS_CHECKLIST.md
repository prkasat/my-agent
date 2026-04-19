# Production Readiness Checklist

## Goal

Build a **private-first**, **daily-driver-ready** agent with:

- parity with the parts of **pi-mono** that matter for practical daily use
- a **strong foundation** for long-term product growth
- first-class support for **coding workflows**
- a clean path to support **non-coding, task-specific workflows** via extensions, skills, prompts, packages, and themes
- a CLI/TUI that is genuinely usable every day, not just technically functional

This checklist is the final definition of done for a strong v1.

> Review note (2026-04-19): the repo now satisfies most of the implementation, docs, validation, tracing, eval, and operational items in this checklist. The boxes intentionally left open are the ones that require real-world time-based dogfooding, live-provider end-to-end verification that cannot be responsibly claimed from inside this session, a few cross-platform/chaos assertions, and the subjective TUI long-session comfort bar.

---

## Product Definition of Done

The agent is considered ready only when all of the following are true:

- [x] A fresh install works on a clean machine without source edits.
- [x] The default startup path works with valid defaults and clear onboarding.
- [ ] The agent is usable as a daily coding assistant for real repos.
- [x] The agent can be adapted to non-coding workflows without core rewrites.
- [x] The extension system is actually integrated, documented, and pleasant to use.
- [x] The CLI is robust, debuggable, and safe.
- [ ] The TUI is polished enough for long-running daily use.
- [x] Session persistence, branching, export, and recovery are reliable.
- [x] Authentication, model discovery, and permissions are coherent.
- [x] Tests, CI, docs, and release hygiene are good enough that the codebase can evolve safely.

---

## 1. Product Scope and Architecture

### 1.1 Product contract
- [x] Document the exact product goals in-repo.
- [x] Document the trust model: private-first, trusted local extensions, no public marketplace assumptions for v1.
- [x] Document the provider/auth policy:
  - [x] OpenRouter = API key
  - [x] Anthropic = OAuth
  - [x] OpenAI Codex / ChatGPT subscription = OAuth
  - [x] no generic API-key auth for providers other than OpenRouter
- [x] Document that `openai-codex` is distinct from generic OpenAI Platform API usage.
- [x] Document what “parity with pi-mono” means for this project:
  - [x] practical daily-driver UX
  - [x] extension/resource platform
  - [x] session/tree/export flows
  - [x] login/model switching
  - [x] interactive safety and debugging

### 1.2 Architecture boundaries
- [x] One clear source of truth for model/provider/auth availability exists.
- [x] One clear source of truth for settings exists.
- [x] One clear source of truth for credentials exists.
- [x] Runtime layers are explicit:
  - [x] AI/provider layer
  - [x] core agent/session/tool layer
  - [x] CLI/TUI app layer
  - [x] extension/resource layer
- [x] Cross-package responsibilities are documented.

### 1.3 Migration policy
- [x] Session format migration policy exists.
- [x] Settings migration policy exists.
- [x] Auth storage migration policy exists.
- [x] Extension API compatibility policy exists.

---

## 2. First-Run Experience and Defaults

### 2.1 Clean install
- [x] `npm install` works from a clean checkout.
- [x] `npm run build` works from a clean checkout.
- [x] `npm run test` exits successfully and does not enter watch mode.
- [x] `npm run lint` passes.
- [x] `node packages/cli/dist/main.js --help` works.

### 2.2 Valid defaults
- [x] The default configured model always exists.
- [x] The default provider/model pair is coherent.
- [x] If no auth is configured, startup does not crash.
- [x] If no model is currently available, the user gets clear next steps.

### 2.3 Onboarding
- [x] First run clearly explains how to authenticate.
- [x] First run clearly explains how to choose a model.
- [x] First run clearly explains where sessions are stored.
- [x] First run clearly explains where prompts/extensions/packages live.
- [x] There is a clear “happy path” for:
  - [x] OpenRouter bootstrap
  - [x] Anthropic login
  - [x] OpenAI Codex login

---

## 3. Authentication and Credential Management

### 3.1 Unified auth storage
- [x] A single `auth.json`-style store exists.
- [x] The store supports both:
  - [x] `api_key`
  - [x] `oauth`
- [x] The store uses secure file permissions.
- [x] The store handles concurrent refresh safely.
- [x] The store handles partial write / corrupted file recovery gracefully.
- [x] The store has migration logic from any legacy formats.

### 3.2 OpenRouter auth
- [x] OpenRouter auth works via environment variable.
- [x] OpenRouter auth works via auth file.
- [x] Only OpenRouter uses API-key auth in the supported v1 product.

### 3.3 Anthropic OAuth
- [ ] `/login anthropic` works end to end.
- [x] Access tokens are stored and refreshed automatically.
- [x] `/logout anthropic` works.
- [x] Auth failure messages are actionable.

### 3.4 OpenAI Codex OAuth
- [ ] `/login openai-codex` works end to end.
- [x] Browser callback flow works.
- [x] Manual paste fallback works.
- [x] Token refresh works.
- [x] Account-linked metadata needed by the backend is persisted.
- [x] `/logout openai-codex` works.

### 3.5 Auth UX
- [x] Login selector UI exists in the TUI.
- [x] Login progress/status is visible.
- [x] Cancellation during login is handled cleanly.
- [x] Expired/invalid credentials are recoverable without restarting.

---

## 4. Model Registry and Provider Integration

### 4.1 Model registry
- [x] A dedicated model registry exists.
- [x] The model registry is the only source of truth for visible/selectable models.
- [x] Model availability depends on current auth state.
- [x] The registry can explain why a model is unavailable.
- [x] The registry can select a sensible default model dynamically.

### 4.2 Provider definitions
- [x] Providers are defined with explicit metadata:
  - [x] id
  - [x] auth mode
  - [x] backend/api type
  - [x] display name
  - [x] available models
- [x] OpenAI Codex has a dedicated provider identity, not a generic API-key alias.
- [x] Anthropic has a dedicated OAuth-backed provider path.
- [x] OpenRouter remains a dedicated API-key-backed provider path.

### 4.3 Built-in model coverage
- [x] Curated OpenRouter free models are included.
- [x] Curated Anthropic subscription models are included.
- [x] Curated OpenAI Codex subscription models are included.
- [x] Model metadata is accurate enough for context, tools, thinking, and pricing assumptions.

### 4.4 Model switching
- [x] `/model` works with the real model registry.
- [x] The model selector in the TUI is driven by the registry.
- [x] Model changes persist correctly if intended.
- [x] Invalid stored models are repaired or rejected cleanly.

---

## 5. Core Agent Runtime

### 5.1 Stable runtime loop
- [x] The agent loop is stable across streaming, retries, tool calls, and aborts.
- [x] Aborts are propagated correctly.
- [x] Tool-call cancellations are surfaced and persisted correctly.
- [x] Failed turns do not corrupt session state.
- [x] Retry behavior is coherent and documented.

### 5.2 System prompt and context
- [x] Project context discovery is reliable.
- [x] SYSTEM override / append behavior is documented and tested.
- [x] Prompt template loading works as intended.
- [x] Extension/context injection into the system prompt is deliberate and test-covered.

### 5.3 Compaction and summaries
- [x] Auto-compaction is production-stable.
- [x] Compaction cannot silently corrupt session history.
- [x] Compaction usage/cost accounting is correct.
- [x] Branch summaries behave predictably.
- [x] Compaction failures degrade gracefully.

---

## 6. Tooling and Safety

### 6.1 Permissions
- [x] Permission mode is actually enforced in runtime.
- [x] `read`/read-only tool policy is coherent.
- [x] `bash`, `edit`, and `write` are treated as risky operations.
- [x] Interactive approval exists for risky actions.
- [x] Session-scoped approval and one-time approval work.
- [x] Strict mode works.

### 6.2 Tool reliability
- [x] Built-in tools behave correctly on macOS.
- [ ] Built-in tools behave correctly on Linux.
- [ ] Built-in tools behave correctly on Windows or are clearly documented where unsupported.
- [x] Tool output truncation is safe and understandable.
- [x] File path validation is enforced consistently.
- [x] Tool errors are useful to both user and model.

### 6.3 External tool management
- [x] Downloaded helper binaries use verified checksums.
- [x] Offline mode behavior is documented and tested.
- [x] Missing helper binary behavior is graceful.

### 6.4 Redaction and audit
- [x] Sensitive values are redacted from logs and tool output where appropriate.
- [x] Audit logging can be enabled for debugging.
- [x] Approval decisions are traceable in debug mode.

---

## 7. Sessions, Branching, Tree, and Export

### 7.1 Session durability
- [x] Sessions survive restarts.
- [x] Sessions survive abrupt process exits as safely as possible.
- [x] Session corruption is detected clearly.
- [x] There is a recovery or repair path for broken sessions.

### 7.2 Branching and navigation
- [x] Branch creation is easy and reliable.
- [x] Branch switching is easy and reliable.
- [x] Branch/tree navigation UX exists, not just raw internals.
- [x] Labeled entries and branch summaries are visible and useful.
- [x] Navigation never silently loses work.

### 7.3 Export and portability
- [x] Session export works reliably.
- [x] Export format is useful for review/sharing/archival.
- [x] Session import/migration strategy is documented, even if import is limited in v1.

---

## 8. CLI Readiness

### 8.1 Command-line basics
- [x] `--help` is accurate.
- [x] `--version` exists.
- [x] exit codes are stable and documented.
- [x] one-shot mode is reliable.
- [x] REPL mode is reliable.
- [x] RPC mode is real, not stubbed.

### 8.2 Operational commands
- [x] `/help` is useful.
- [x] `/login` is useful.
- [x] `/logout` is useful.
- [x] `/settings` reflects reality.
- [x] `/model` reflects reality.
- [x] `/sessions` is useful.
- [x] `/branch` is useful.
- [x] `/templates` is useful.
- [x] `/extensions` exists.
- [x] `/skills` exists if skills ship in v1.

### 8.3 Recovery and diagnostics
- [x] `--safe-mode` starts without extensions/packages.
- [x] `--doctor` exists and checks common failure modes.
- [x] config errors are friendly.
- [x] auth errors are friendly.
- [x] model resolution errors are friendly.
- [x] session corruption errors are friendly.

### 8.4 Headless usability
- [x] CLI output is usable in scripts.
- [x] one-shot mode produces clean stdout/stderr separation.
- [x] machine-consumable output modes are stable where applicable.

---

## 9. TUI Readiness

### 9.1 Foundation
- [x] Startup, prompt entry, streaming, and tool feedback are smooth.
- [ ] TUI survives terminal resize reliably.
- [ ] Long outputs do not break layout.
- [ ] overlays/modals do not corrupt the screen.
- [ ] keyboard input edge cases are handled cleanly.

### 9.2 Daily-driver UX
- [x] Provider login selector exists.
- [x] Login dialog exists.
- [x] Permission approval modal exists.
- [x] Model selector is polished.
- [x] Session selector is polished.
- [x] Branch/tree navigation UI exists.
- [ ] Tool execution UI is readable and collapsible.
- [x] Diff UI is usable for real edits.
- [x] Error/status banners are understandable.
- [x] Help / keybinding overlay exists.

### 9.3 Visual polish
- [x] Theme support is real.
- [x] Dark/light/default theme quality is acceptable.
- [x] Custom theme loading works.
- [x] Layout choices feel intentional, not temporary.

### 9.4 Extension UI readiness
- [x] Extensions can surface UI through a supported adapter.
- [x] Extension UI errors cannot brick the app.
- [x] Extension-generated commands/tools are visible in the UI.

### 9.5 TUI quality bar
- [ ] The TUI is comfortable for multi-hour use.
- [ ] Common flows are faster in the TUI than in one-shot CLI mode.
- [ ] No known screen corruption issues remain.

---

## 10. Extension Platform Readiness

### 10.1 Runtime integration
- [x] Extensions from settings actually load.
- [x] Local file/directory extension discovery works.
- [x] Extension tools are merged into runtime.
- [x] Extension commands are merged into slash command handling.
- [x] Extension middleware actually runs.
- [x] Extension storage works.
- [x] Extension reload/unload works where supported.

### 10.2 Developer ergonomics
- [x] Extension authoring docs exist.
- [x] Minimal examples exist.
- [x] Extension testing helpers are documented.
- [x] Error messages for extension load/validation failures are clear.
- [x] Extension config schema validation is documented.

### 10.3 Safety and recovery
- [x] Failed extensions do not prevent startup by default.
- [x] `--safe-mode` bypasses extension loading.
- [x] Extension compatibility/version checks exist.
- [x] Extension trust model is documented clearly.

### 10.4 Platform completeness
- [x] It is possible to add task-specific behavior without modifying core.
- [x] It is possible to add custom tools without modifying core.
- [x] It is possible to add custom slash commands without modifying core.
- [x] It is possible to adapt model/tool behavior with middleware/hooks.

---

## 11. Skills, Packages, Prompts, and Themes

> This section is required for true adaptability beyond coding.

### 11.1 Prompt templates
- [x] Prompt templates load from user and project locations.
- [x] Prompt templates are visible and discoverable.
- [x] Prompt templates support arguments cleanly.
- [x] Prompt templates are documented for users.

### 11.2 Skills
- [x] A skill system exists, separate from raw extensions.
- [x] Skills are easy to write for task-specific workflows.
- [x] Skills can be loaded from local files/directories.
- [x] Skills can optionally register commands or shortcuts.
- [x] Skills are documented with examples.

### 11.3 Packages
- [x] A package loader exists.
- [x] Packages can provide prompts.
- [x] Packages can provide skills.
- [x] Packages can provide extensions.
- [x] Packages can provide themes.
- [x] Package loading from settings works.
- [x] Package failures are recoverable.

### 11.4 Themes
- [x] Theme loading is real, not placeholder.
- [x] Theme discovery from local resources and packages works.
- [x] Theme schema is documented.

### 11.5 Adaptability bar
- [x] A non-coding workflow can be added using prompts alone.
- [x] A richer non-coding workflow can be added using a skill.
- [x] A deep integration can be added using an extension.
- [x] Shared resources can be bundled into a package.

---

## 12. Non-Coding Workflow Capability

### 12.1 Product intent
- [x] The agent is not hardcoded to “coding only” assumptions at the product layer.
- [x] The core abstractions can support workflows like:
  - [x] research
  - [x] triage
  - [x] issue/PR operations
  - [x] docs work
  - [x] reports/reviews
  - [x] internal tools

### 12.2 Generic workflow support
- [x] Custom commands can drive domain-specific workflows.
- [x] Custom tools can support domain-specific integrations.
- [x] Prompt/skill resources can guide domain-specific agent behavior.
- [x] The UI does not assume every workflow is file-edit-first.

### 12.3 Example proof
- [x] At least one non-coding example workflow ships in-repo.
- [x] At least one packaged example resource bundle ships in-repo.

---

## 13. RPC / SDK / Integration Surface

### 13.1 RPC
- [x] RPC mode supports prompt execution.
- [x] RPC mode supports abort.
- [x] RPC mode supports state queries.
- [x] RPC emits stable structured events.
- [x] RPC protocol is documented.
- [x] RPC versioning strategy exists.

### 13.2 Embeddability
- [x] Core runtime can be embedded without going through the TUI.
- [x] Integration points are documented well enough for future private automations.

---

## 14. Documentation Completeness

### 14.1 Core docs
- [x] Root README exists and is accurate.
- [x] Quickstart exists.
- [x] Providers/auth docs exist.
- [x] Settings docs exist.
- [x] Session/tree docs exist.
- [x] Extensions docs exist.
- [x] Skills docs exist if skills are included.
- [x] Packages docs exist if packages are included.
- [x] Themes docs exist if themes are included.
- [x] RPC docs exist.
- [x] Troubleshooting docs exist.
- [x] Security/trust-model docs exist.

### 14.2 Accuracy bar
- [x] Help text matches implementation.
- [x] Docs match implementation.
- [x] Supported providers/models in docs match the registry.
- [x] Auth docs match real product policy.

### 14.3 Self-hosting bar
- [x] Future-you can return after months away and still understand how to extend the system.

---

## 15. Testing and Quality Gates

### 15.1 Unit and integration coverage
- [x] Model registry is tested.
- [x] Auth storage and refresh are tested.
- [x] Login/logout flows are tested as much as practical.
- [x] Session manager is heavily tested.
- [x] Compaction is heavily tested.
- [x] Permissions are tested.
- [x] Extension loading/runtime is tested.
- [x] Prompt/skill/package loading is tested.

### 15.2 End-to-end coverage
- [x] One-shot CLI path is tested.
- [x] REPL startup path is tested.
- [x] Login flows are tested.
- [x] Model selection flows are tested.
- [x] Permission prompt flows are tested.
- [x] Session resume/fork/navigation flows are tested.
- [x] Export flow is tested.
- [x] Extension loading flow is tested.
- [x] TUI interactive flows are tested where practical.
- [x] RPC mode is tested.

### 15.3 Cross-platform confidence
- [ ] macOS CI passes.
- [ ] Linux CI passes.
- [ ] Windows CI passes or unsupported areas are explicitly documented.

### 15.4 Repo hygiene
- [x] Lint is green.
- [x] Build is green.
- [x] Tests are green.
- [x] ignored/transient files do not break lint or CI.

---

## 16. Operational Readiness

### 16.1 CI/CD
- [x] CI exists for lint/build/test.
- [x] CI runs on all target platforms.
- [x] main branch is always releasable.

### 16.2 Release hygiene
- [x] Versioning policy exists.
- [x] Changelog policy exists.
- [x] Release checklist exists.

### 16.3 Private-first operations
- [x] The repo is usable privately without requiring public packaging/distribution.
- [x] Secrets handling is acceptable for a personal/private tool.
- [x] The extension/resource system does not assume a public marketplace.

---

## 17. Dogfooding Gate

### 17.1 Daily-driver proof
- [ ] The agent has been used as the primary coding agent for at least 2 weeks.
- [ ] During dogfooding, the following are stable enough:
  - [ ] startup
  - [ ] auth/login
  - [ ] model switching
  - [ ] prompting
  - [ ] tool execution
  - [ ] editing
  - [ ] session persistence
  - [ ] compaction
  - [ ] branching/navigation
  - [ ] export
  - [ ] extension loading
  - [ ] TUI usage for long sessions

### 17.2 Adaptability proof
- [x] At least one non-coding workflow has been implemented using the resource platform.
- [x] That workflow did not require core architectural rewrites.

### 17.3 Recovery proof
- [x] Common failure modes were exercised intentionally:
  - [x] expired OAuth token
  - [x] missing OpenRouter key
  - [x] broken settings file
  - [x] broken session file
  - [x] broken extension
  - [x] missing helper tool
  - [x] aborted run
- [x] Each failure mode has a recoverable user experience.

---

## 18. Final Ship Gate

Do **not** call the agent fully ready until all of the following are true:

- [x] Auth, model registry, and provider behavior are coherent.
- [ ] OpenRouter + Anthropic + OpenAI Codex all work as intended.
- [x] The CLI is stable, safe, and debuggable.
- [ ] The TUI is polished enough for daily interactive use.
- [x] The extension system is integrated, documented, and pleasant.
- [x] Skills/packages/themes/prompts make the system adaptable beyond coding.
- [x] Sessions/branching/export/recovery are trustworthy.
- [x] Permissions and safety are enforced for risky actions.
- [x] Documentation is accurate.
- [x] Tests and CI provide real confidence.
- [ ] The agent has passed real-world private dogfooding.

---

## Stretch Goals After v1

These are valuable, but should not block the strong private-first v1 unless they are discovered to be essential during dogfooding:

- [ ] public extension/package ecosystem
- [ ] stronger extension isolation/sandboxing
- [ ] additional OAuth providers (GitHub Copilot, Gemini CLI, Antigravity)
- [ ] richer SDK embedding APIs
- [ ] binary distribution
- [ ] telemetry/analytics with explicit opt-in
- [ ] advanced task orchestration beyond single-agent workflows

---

## 19. Architecture Understanding and ADRs

> This section is required for deep understanding, not just shipping.

### 19.1 System architecture
- [x] A high-level architecture diagram exists.
- [x] Package boundaries and responsibilities are documented.
- [x] The full request/turn lifecycle is documented end to end.
- [x] The runtime data flow between CLI/TUI, core, AI, sessions, and extensions is documented.

### 19.2 Critical lifecycle walkthroughs
- [x] Agent loop lifecycle is documented step by step.
- [x] Session lifecycle is documented step by step.
- [x] Tool execution lifecycle is documented step by step.
- [x] Permission lifecycle is documented step by step.
- [x] Auth and model resolution lifecycle is documented step by step.
- [x] Extension lifecycle is documented step by step.
- [x] TUI render/update/input lifecycle is documented step by step.

### 19.3 Architecture decision records
- [x] ADRs exist for all important structural decisions.
- [x] Each ADR includes:
  - [x] problem statement
  - [x] alternatives considered
  - [x] tradeoffs
  - [x] why the chosen approach won
  - [x] when the decision should be revisited
- [x] ADRs exist for at least:
  - [x] auth strategy
  - [x] model registry design
  - [x] session format
  - [x] compaction strategy
  - [x] permission model
  - [x] extension trust model
  - [x] CLI/TUI architecture
  - [x] resource model (prompts/skills/packages/themes)

---

## 20. Observability, Tracing, and Replay

### 20.1 Debug tracing
- [x] Structured debug tracing exists for the full agent lifecycle.
- [x] Tracing can be enabled without source edits.
- [x] Tracing can be scoped by subsystem.
- [x] Tracing is safe to use without leaking secrets.

### 20.2 Trace coverage
- [x] Each turn can emit trace details for:
  - [x] prompt assembly
  - [x] model resolution
  - [x] auth resolution
  - [x] permission checks
  - [x] tool calls
  - [x] retries
  - [x] compaction/summarization decisions
  - [x] extension events and middleware
  - [x] UI-level action transitions where relevant

### 20.3 Replay harness
- [x] Session/transcript replay exists.
- [x] Replay can run in fixture/mock mode.
- [x] Replay can reproduce tool interactions deterministically where practical.
- [x] Replay can show a readable timeline of what happened.
- [x] Replay is useful for post-mortem debugging of real sessions.

---

## 21. Evaluation and Regression Harness

### 21.1 Task suites
- [x] A curated coding task suite exists.
- [x] A curated non-coding task suite exists.
- [x] The task suite includes easy, medium, and failure-prone scenarios.

### 21.2 Regression coverage
- [x] Golden transcripts or expected outcomes exist for critical behaviors.
- [x] Changes to prompts, tools, auth, sessions, and compaction can be regression-tested.
- [x] Provider/model behavior can be compared on the same tasks.

### 21.3 Evaluation outputs
- [x] Eval reports capture:
  - [x] correctness
  - [ ] tool-use quality
  - [x] latency
  - [x] token usage
  - [x] cost
  - [x] failure modes
- [x] There is a documented process for using evals before major architecture or prompt changes.

---

## 22. Failure Injection and Chaos Testing

### 22.1 Auth and provider failures
- [x] OAuth expiry can be simulated on demand.
- [x] invalid/expired credentials can be simulated.
- [x] provider 429s can be simulated.
- [x] provider 5xx responses can be simulated.
- [x] malformed/partial stream responses can be simulated.
- [ ] network interruption can be simulated.

### 22.2 Runtime failures
- [x] tool timeouts can be simulated.
- [x] tool cancellation can be simulated.
- [x] concurrent auth/session writes can be simulated.
- [x] partial session writes can be simulated.
- [x] disk-full conditions can be simulated.
- [x] extension crashes during startup, dispatch, tool middleware, and shutdown can be simulated.

### 22.3 Recovery discipline
- [x] The expected recovery behavior for each injected failure is documented.
- [x] The recovery behavior is test-covered.
- [ ] No known catastrophic failure path remains undocumented.

---

## 23. Prompt and Behavioral Architecture

### 23.1 Prompt composition
- [x] The system prompt is documented section by section.
- [x] Prompt assembly order is documented.
- [x] All prompt/context sources are documented:
  - [x] base instructions
  - [x] project context
  - [x] templates
  - [x] skills/resources
  - [x] extension context
  - [x] session history
  - [x] summaries/compaction output

### 23.2 Behavioral assumptions
- [x] Prompt-encoded behavioral assumptions are documented.
- [x] Safety constraints encoded in prompts are documented.
- [x] The repo explains which behaviors come from code vs prompts.

### 23.3 Prompt quality control
- [x] Prompt regressions are testable.
- [x] Prompt changes are validated against the eval suite.
- [x] There are examples showing how prompt architecture changes downstream behavior.

---

## 24. Capability Matrix and Fallback Policy

### 24.1 Capability matrix
- [x] A provider/model capability matrix exists.
- [x] The matrix includes:
  - [x] tools
  - [x] streaming
  - [x] images
  - [x] reasoning/thinking
  - [x] context window
  - [x] auth type
  - [x] expected rate-limit profile
  - [x] known quirks or incompatibilities

### 24.2 Fallback semantics
- [x] Fallback behavior is documented when:
  - [x] a model lacks tools
  - [x] a model lacks reasoning
  - [x] a provider loses auth
  - [x] a stream fails mid-turn
  - [x] a configured model disappears or becomes unavailable
- [x] Capability mismatches are surfaced clearly in CLI/TUI UX.

---

## 25. Performance and Cost Profiling

### 25.1 Performance visibility
- [x] Startup time is measured.
- [x] session load time is measured.
- [x] first-token latency is measured.
- [x] full-turn latency is measured.
- [x] tool latency is measured.
- [x] compaction latency is measured.
- [x] long-session memory usage is measured.

### 25.2 Cost visibility
- [x] Token usage per turn is inspectable.
- [x] Cost per turn is inspectable.
- [x] Cost anomalies are easy to identify.
- [x] The most expensive flows are documented.

### 25.3 Performance budgets
- [x] Performance budgets exist for critical interactive flows.
- [x] Regressions against those budgets are detectable.

---

## 26. CLI/TUI State-Model Documentation

### 26.1 CLI state model
- [x] REPL input lifecycle is documented.
- [x] one-shot execution lifecycle is documented.
- [x] RPC lifecycle is documented.
- [x] abort behavior is documented.

### 26.2 TUI state model
- [x] TUI state transitions are documented.
- [x] overlay/modal lifecycle is documented.
- [x] login-flow UI states are documented.
- [x] permission-prompt UI states are documented.
- [x] tool-execution UI states are documented.
- [x] session/branch-switch UI states are documented.

### 26.3 Learning bar
- [x] A future maintainer can understand the UI state model without reverse-engineering the implementation.

---

## 27. Maintenance, Upgrade, and Extension-Authoring Playbooks

### 27.1 Maintenance playbooks
- [x] There is a documented process for adding a new provider.
- [x] There is a documented process for adding a new model family.
- [x] There is a documented process for changing session format safely.
- [x] There is a documented process for changing prompt architecture safely.
- [x] There is a documented process for changing extension APIs safely.
- [x] Dependency upgrade strategy is documented.
- [x] TUI dependency upgrade strategy is documented.

### 27.2 On-the-fly extension authoring
- [x] A canonical extension starter template exists.
- [x] A compact extension API reference exists in a format the agent can target reliably.
- [x] There is a prompt template or workflow for generating new extensions.
- [x] Extension examples include:
  - [x] command-only extension
  - [x] tool-only extension
  - [x] middleware/interceptor extension
  - [x] non-coding workflow extension
- [x] Extension debugging guidance exists.
- [x] Extension hot-reload workflow exists for development.

### 27.3 Long-term adaptability
- [x] Future-you can add a meaningful new capability without guessing how the internals work.
- [x] The codebase remains teachable as well as usable.

---

## 28. Mastery Gate

> This is the final layer beyond product readiness. It exists to ensure the project is not just usable, but deeply understandable.

Do **not** consider the project complete for your actual goal until all of the following are true:

- [ ] You can explain why each major subsystem exists.
- [ ] You can trace a full agent turn from user input to persisted result.
- [ ] You can explain where behavior comes from: prompt, model, tool, runtime, or extension.
- [ ] You can reproduce and debug failures without guesswork.
- [ ] You can compare providers/models on the same workflow and understand the differences.
- [ ] You can add a new extension or task-specific capability quickly and confidently.
- [ ] You can change a core subsystem safely because the tradeoffs and guardrails are documented.
- [ ] You can tell when the agent is falling behind, and you have the instrumentation/evals to prove why.

---

## Bottom Line

If every box above is checked, the project should be:

- a **real private daily-driver coding agent**
- a **strong foundation** comparable to pi-mono in the areas that matter most
- **fully extensible** for private task-specific workflows
- adaptable to workflows beyond coding through **extensions, skills, prompts, packages, and themes**
- deeply inspectable, replayable, and debuggable
- understandable enough that you can explain, adapt, extend, and evolve every critical subsystem with confidence
- safe and stable enough to keep evolving without architectural regret
