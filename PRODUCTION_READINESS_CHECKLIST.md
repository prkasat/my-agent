# Production Readiness Checklist

## Goal

Build a **private-first**, **daily-driver-ready** agent with:

- parity with the parts of **pi-mono** that matter for practical daily use
- a **strong foundation** for long-term product growth
- first-class support for **coding workflows**
- a clean path to support **non-coding, task-specific workflows** via extensions, skills, prompts, packages, and themes
- a CLI/TUI that is genuinely usable every day, not just technically functional

This checklist is the final definition of done for a strong v1.

> Status note (2026-04-19): the repo now implements the major product/runtime/platform/doc/CI work tracked here. The remaining gates that cannot be truthfully completed inside a single coding session are the explicitly real-world/time-based dogfooding proofs and subjective long-session comfort claims. Those require actual usage, not source edits.

---

## Product Definition of Done

The agent is considered ready only when all of the following are true:

- [ ] A fresh install works on a clean machine without source edits.
- [ ] The default startup path works with valid defaults and clear onboarding.
- [ ] The agent is usable as a daily coding assistant for real repos.
- [ ] The agent can be adapted to non-coding workflows without core rewrites.
- [ ] The extension system is actually integrated, documented, and pleasant to use.
- [ ] The CLI is robust, debuggable, and safe.
- [ ] The TUI is polished enough for long-running daily use.
- [ ] Session persistence, branching, export, and recovery are reliable.
- [ ] Authentication, model discovery, and permissions are coherent.
- [ ] Tests, CI, docs, and release hygiene are good enough that the codebase can evolve safely.

---

## 1. Product Scope and Architecture

### 1.1 Product contract
- [ ] Document the exact product goals in-repo.
- [ ] Document the trust model: private-first, trusted local extensions, no public marketplace assumptions for v1.
- [ ] Document the provider/auth policy:
  - [ ] OpenRouter = API key
  - [ ] Anthropic = OAuth
  - [ ] OpenAI Codex / ChatGPT subscription = OAuth
  - [ ] no generic API-key auth for providers other than OpenRouter
- [ ] Document that `openai-codex` is distinct from generic OpenAI Platform API usage.
- [ ] Document what “parity with pi-mono” means for this project:
  - [ ] practical daily-driver UX
  - [ ] extension/resource platform
  - [ ] session/tree/export flows
  - [ ] login/model switching
  - [ ] interactive safety and debugging

### 1.2 Architecture boundaries
- [ ] One clear source of truth for model/provider/auth availability exists.
- [ ] One clear source of truth for settings exists.
- [ ] One clear source of truth for credentials exists.
- [ ] Runtime layers are explicit:
  - [ ] AI/provider layer
  - [ ] core agent/session/tool layer
  - [ ] CLI/TUI app layer
  - [ ] extension/resource layer
- [ ] Cross-package responsibilities are documented.

### 1.3 Migration policy
- [ ] Session format migration policy exists.
- [ ] Settings migration policy exists.
- [ ] Auth storage migration policy exists.
- [ ] Extension API compatibility policy exists.

---

## 2. First-Run Experience and Defaults

### 2.1 Clean install
- [ ] `npm install` works from a clean checkout.
- [ ] `npm run build` works from a clean checkout.
- [ ] `npm run test` exits successfully and does not enter watch mode.
- [ ] `npm run lint` passes.
- [ ] `node packages/cli/dist/main.js --help` works.

### 2.2 Valid defaults
- [ ] The default configured model always exists.
- [ ] The default provider/model pair is coherent.
- [ ] If no auth is configured, startup does not crash.
- [ ] If no model is currently available, the user gets clear next steps.

### 2.3 Onboarding
- [ ] First run clearly explains how to authenticate.
- [ ] First run clearly explains how to choose a model.
- [ ] First run clearly explains where sessions are stored.
- [ ] First run clearly explains where prompts/extensions/packages live.
- [ ] There is a clear “happy path” for:
  - [ ] OpenRouter bootstrap
  - [ ] Anthropic login
  - [ ] OpenAI Codex login

---

## 3. Authentication and Credential Management

### 3.1 Unified auth storage
- [ ] A single `auth.json`-style store exists.
- [ ] The store supports both:
  - [ ] `api_key`
  - [ ] `oauth`
- [ ] The store uses secure file permissions.
- [ ] The store handles concurrent refresh safely.
- [ ] The store handles partial write / corrupted file recovery gracefully.
- [ ] The store has migration logic from any legacy formats.

### 3.2 OpenRouter auth
- [ ] OpenRouter auth works via environment variable.
- [ ] OpenRouter auth works via auth file.
- [ ] Only OpenRouter uses API-key auth in the supported v1 product.

### 3.3 Anthropic OAuth
- [ ] `/login anthropic` works end to end.
- [ ] Access tokens are stored and refreshed automatically.
- [ ] `/logout anthropic` works.
- [ ] Auth failure messages are actionable.

### 3.4 OpenAI Codex OAuth
- [ ] `/login openai-codex` works end to end.
- [ ] Browser callback flow works.
- [ ] Manual paste fallback works.
- [ ] Token refresh works.
- [ ] Account-linked metadata needed by the backend is persisted.
- [ ] `/logout openai-codex` works.

### 3.5 Auth UX
- [ ] Login selector UI exists in the TUI.
- [ ] Login progress/status is visible.
- [ ] Cancellation during login is handled cleanly.
- [ ] Expired/invalid credentials are recoverable without restarting.

---

## 4. Model Registry and Provider Integration

### 4.1 Model registry
- [ ] A dedicated model registry exists.
- [ ] The model registry is the only source of truth for visible/selectable models.
- [ ] Model availability depends on current auth state.
- [ ] The registry can explain why a model is unavailable.
- [ ] The registry can select a sensible default model dynamically.

### 4.2 Provider definitions
- [ ] Providers are defined with explicit metadata:
  - [ ] id
  - [ ] auth mode
  - [ ] backend/api type
  - [ ] display name
  - [ ] available models
- [ ] OpenAI Codex has a dedicated provider identity, not a generic API-key alias.
- [ ] Anthropic has a dedicated OAuth-backed provider path.
- [ ] OpenRouter remains a dedicated API-key-backed provider path.

### 4.3 Built-in model coverage
- [ ] Curated OpenRouter free models are included.
- [ ] Curated Anthropic subscription models are included.
- [ ] Curated OpenAI Codex subscription models are included.
- [ ] Model metadata is accurate enough for context, tools, thinking, and pricing assumptions.

### 4.4 Model switching
- [ ] `/model` works with the real model registry.
- [ ] The model selector in the TUI is driven by the registry.
- [ ] Model changes persist correctly if intended.
- [ ] Invalid stored models are repaired or rejected cleanly.

---

## 5. Core Agent Runtime

### 5.1 Stable runtime loop
- [ ] The agent loop is stable across streaming, retries, tool calls, and aborts.
- [ ] Aborts are propagated correctly.
- [ ] Tool-call cancellations are surfaced and persisted correctly.
- [ ] Failed turns do not corrupt session state.
- [ ] Retry behavior is coherent and documented.

### 5.2 System prompt and context
- [ ] Project context discovery is reliable.
- [ ] SYSTEM override / append behavior is documented and tested.
- [ ] Prompt template loading works as intended.
- [ ] Extension/context injection into the system prompt is deliberate and test-covered.

### 5.3 Compaction and summaries
- [ ] Auto-compaction is production-stable.
- [ ] Compaction cannot silently corrupt session history.
- [ ] Compaction usage/cost accounting is correct.
- [ ] Branch summaries behave predictably.
- [ ] Compaction failures degrade gracefully.

---

## 6. Tooling and Safety

### 6.1 Permissions
- [ ] Permission mode is actually enforced in runtime.
- [ ] `read`/read-only tool policy is coherent.
- [ ] `bash`, `edit`, and `write` are treated as risky operations.
- [ ] Interactive approval exists for risky actions.
- [ ] Session-scoped approval and one-time approval work.
- [ ] Strict mode works.

### 6.2 Tool reliability
- [ ] Built-in tools behave correctly on macOS.
- [ ] Built-in tools behave correctly on Linux.
- [ ] Built-in tools behave correctly on Windows or are clearly documented where unsupported.
- [ ] Tool output truncation is safe and understandable.
- [ ] File path validation is enforced consistently.
- [ ] Tool errors are useful to both user and model.

### 6.3 External tool management
- [ ] Downloaded helper binaries use verified checksums.
- [ ] Offline mode behavior is documented and tested.
- [ ] Missing helper binary behavior is graceful.

### 6.4 Redaction and audit
- [ ] Sensitive values are redacted from logs and tool output where appropriate.
- [ ] Audit logging can be enabled for debugging.
- [ ] Approval decisions are traceable in debug mode.

---

## 7. Sessions, Branching, Tree, and Export

### 7.1 Session durability
- [ ] Sessions survive restarts.
- [ ] Sessions survive abrupt process exits as safely as possible.
- [ ] Session corruption is detected clearly.
- [ ] There is a recovery or repair path for broken sessions.

### 7.2 Branching and navigation
- [ ] Branch creation is easy and reliable.
- [ ] Branch switching is easy and reliable.
- [ ] Branch/tree navigation UX exists, not just raw internals.
- [ ] Labeled entries and branch summaries are visible and useful.
- [ ] Navigation never silently loses work.

### 7.3 Export and portability
- [ ] Session export works reliably.
- [ ] Export format is useful for review/sharing/archival.
- [ ] Session import/migration strategy is documented, even if import is limited in v1.

---

## 8. CLI Readiness

### 8.1 Command-line basics
- [ ] `--help` is accurate.
- [ ] `--version` exists.
- [ ] exit codes are stable and documented.
- [ ] one-shot mode is reliable.
- [ ] REPL mode is reliable.
- [ ] RPC mode is real, not stubbed.

### 8.2 Operational commands
- [ ] `/help` is useful.
- [ ] `/login` is useful.
- [ ] `/logout` is useful.
- [ ] `/settings` reflects reality.
- [ ] `/model` reflects reality.
- [ ] `/sessions` is useful.
- [ ] `/branch` is useful.
- [ ] `/templates` is useful.
- [ ] `/extensions` exists.
- [ ] `/skills` exists if skills ship in v1.

### 8.3 Recovery and diagnostics
- [ ] `--safe-mode` starts without extensions/packages.
- [ ] `--doctor` exists and checks common failure modes.
- [ ] config errors are friendly.
- [ ] auth errors are friendly.
- [ ] model resolution errors are friendly.
- [ ] session corruption errors are friendly.

### 8.4 Headless usability
- [ ] CLI output is usable in scripts.
- [ ] one-shot mode produces clean stdout/stderr separation.
- [ ] machine-consumable output modes are stable where applicable.

---

## 9. TUI Readiness

### 9.1 Foundation
- [ ] Startup, prompt entry, streaming, and tool feedback are smooth.
- [ ] TUI survives terminal resize reliably.
- [ ] Long outputs do not break layout.
- [ ] overlays/modals do not corrupt the screen.
- [ ] keyboard input edge cases are handled cleanly.

### 9.2 Daily-driver UX
- [ ] Provider login selector exists.
- [ ] Login dialog exists.
- [ ] Permission approval modal exists.
- [ ] Model selector is polished.
- [ ] Session selector is polished.
- [ ] Branch/tree navigation UI exists.
- [ ] Tool execution UI is readable and collapsible.
- [ ] Diff UI is usable for real edits.
- [ ] Error/status banners are understandable.
- [ ] Help / keybinding overlay exists.

### 9.3 Visual polish
- [ ] Theme support is real.
- [ ] Dark/light/default theme quality is acceptable.
- [ ] Custom theme loading works.
- [ ] Layout choices feel intentional, not temporary.

### 9.4 Extension UI readiness
- [ ] Extensions can surface UI through a supported adapter.
- [ ] Extension UI errors cannot brick the app.
- [ ] Extension-generated commands/tools are visible in the UI.

### 9.5 TUI quality bar
- [ ] The TUI is comfortable for multi-hour use.
- [ ] Common flows are faster in the TUI than in one-shot CLI mode.
- [ ] No known screen corruption issues remain.

---

## 10. Extension Platform Readiness

### 10.1 Runtime integration
- [ ] Extensions from settings actually load.
- [ ] Local file/directory extension discovery works.
- [ ] Extension tools are merged into runtime.
- [ ] Extension commands are merged into slash command handling.
- [ ] Extension middleware actually runs.
- [ ] Extension storage works.
- [ ] Extension reload/unload works where supported.

### 10.2 Developer ergonomics
- [ ] Extension authoring docs exist.
- [ ] Minimal examples exist.
- [ ] Extension testing helpers are documented.
- [ ] Error messages for extension load/validation failures are clear.
- [ ] Extension config schema validation is documented.

### 10.3 Safety and recovery
- [ ] Failed extensions do not prevent startup by default.
- [ ] `--safe-mode` bypasses extension loading.
- [ ] Extension compatibility/version checks exist.
- [ ] Extension trust model is documented clearly.

### 10.4 Platform completeness
- [ ] It is possible to add task-specific behavior without modifying core.
- [ ] It is possible to add custom tools without modifying core.
- [ ] It is possible to add custom slash commands without modifying core.
- [ ] It is possible to adapt model/tool behavior with middleware/hooks.

---

## 11. Skills, Packages, Prompts, and Themes

> This section is required for true adaptability beyond coding.

### 11.1 Prompt templates
- [ ] Prompt templates load from user and project locations.
- [ ] Prompt templates are visible and discoverable.
- [ ] Prompt templates support arguments cleanly.
- [ ] Prompt templates are documented for users.

### 11.2 Skills
- [ ] A skill system exists, separate from raw extensions.
- [ ] Skills are easy to write for task-specific workflows.
- [ ] Skills can be loaded from local files/directories.
- [ ] Skills can optionally register commands or shortcuts.
- [ ] Skills are documented with examples.

### 11.3 Packages
- [ ] A package loader exists.
- [ ] Packages can provide prompts.
- [ ] Packages can provide skills.
- [ ] Packages can provide extensions.
- [ ] Packages can provide themes.
- [ ] Package loading from settings works.
- [ ] Package failures are recoverable.

### 11.4 Themes
- [ ] Theme loading is real, not placeholder.
- [ ] Theme discovery from local resources and packages works.
- [ ] Theme schema is documented.

### 11.5 Adaptability bar
- [ ] A non-coding workflow can be added using prompts alone.
- [ ] A richer non-coding workflow can be added using a skill.
- [ ] A deep integration can be added using an extension.
- [ ] Shared resources can be bundled into a package.

---

## 12. Non-Coding Workflow Capability

### 12.1 Product intent
- [ ] The agent is not hardcoded to “coding only” assumptions at the product layer.
- [ ] The core abstractions can support workflows like:
  - [ ] research
  - [ ] triage
  - [ ] issue/PR operations
  - [ ] docs work
  - [ ] reports/reviews
  - [ ] internal tools

### 12.2 Generic workflow support
- [ ] Custom commands can drive domain-specific workflows.
- [ ] Custom tools can support domain-specific integrations.
- [ ] Prompt/skill resources can guide domain-specific agent behavior.
- [ ] The UI does not assume every workflow is file-edit-first.

### 12.3 Example proof
- [ ] At least one non-coding example workflow ships in-repo.
- [ ] At least one packaged example resource bundle ships in-repo.

---

## 13. RPC / SDK / Integration Surface

### 13.1 RPC
- [ ] RPC mode supports prompt execution.
- [ ] RPC mode supports abort.
- [ ] RPC mode supports state queries.
- [ ] RPC emits stable structured events.
- [ ] RPC protocol is documented.
- [ ] RPC versioning strategy exists.

### 13.2 Embeddability
- [ ] Core runtime can be embedded without going through the TUI.
- [ ] Integration points are documented well enough for future private automations.

---

## 14. Documentation Completeness

### 14.1 Core docs
- [ ] Root README exists and is accurate.
- [ ] Quickstart exists.
- [ ] Providers/auth docs exist.
- [ ] Settings docs exist.
- [ ] Session/tree docs exist.
- [ ] Extensions docs exist.
- [ ] Skills docs exist if skills are included.
- [ ] Packages docs exist if packages are included.
- [ ] Themes docs exist if themes are included.
- [ ] RPC docs exist.
- [ ] Troubleshooting docs exist.
- [ ] Security/trust-model docs exist.

### 14.2 Accuracy bar
- [ ] Help text matches implementation.
- [ ] Docs match implementation.
- [ ] Supported providers/models in docs match the registry.
- [ ] Auth docs match real product policy.

### 14.3 Self-hosting bar
- [ ] Future-you can return after months away and still understand how to extend the system.

---

## 15. Testing and Quality Gates

### 15.1 Unit and integration coverage
- [ ] Model registry is tested.
- [ ] Auth storage and refresh are tested.
- [ ] Login/logout flows are tested as much as practical.
- [ ] Session manager is heavily tested.
- [ ] Compaction is heavily tested.
- [ ] Permissions are tested.
- [ ] Extension loading/runtime is tested.
- [ ] Prompt/skill/package loading is tested.

### 15.2 End-to-end coverage
- [ ] One-shot CLI path is tested.
- [ ] REPL startup path is tested.
- [ ] Login flows are tested.
- [ ] Model selection flows are tested.
- [ ] Permission prompt flows are tested.
- [ ] Session resume/fork/navigation flows are tested.
- [ ] Export flow is tested.
- [ ] Extension loading flow is tested.
- [ ] TUI interactive flows are tested where practical.
- [ ] RPC mode is tested.

### 15.3 Cross-platform confidence
- [ ] macOS CI passes.
- [ ] Linux CI passes.
- [ ] Windows CI passes or unsupported areas are explicitly documented.

### 15.4 Repo hygiene
- [ ] Lint is green.
- [ ] Build is green.
- [ ] Tests are green.
- [ ] ignored/transient files do not break lint or CI.

---

## 16. Operational Readiness

### 16.1 CI/CD
- [ ] CI exists for lint/build/test.
- [ ] CI runs on all target platforms.
- [ ] main branch is always releasable.

### 16.2 Release hygiene
- [ ] Versioning policy exists.
- [ ] Changelog policy exists.
- [ ] Release checklist exists.

### 16.3 Private-first operations
- [ ] The repo is usable privately without requiring public packaging/distribution.
- [ ] Secrets handling is acceptable for a personal/private tool.
- [ ] The extension/resource system does not assume a public marketplace.

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
- [ ] At least one non-coding workflow has been implemented using the resource platform.
- [ ] That workflow did not require core architectural rewrites.

### 17.3 Recovery proof
- [ ] Common failure modes were exercised intentionally:
  - [ ] expired OAuth token
  - [ ] missing OpenRouter key
  - [ ] broken settings file
  - [ ] broken session file
  - [ ] broken extension
  - [ ] missing helper tool
  - [ ] aborted run
- [ ] Each failure mode has a recoverable user experience.

---

## 18. Final Ship Gate

Do **not** call the agent fully ready until all of the following are true:

- [ ] Auth, model registry, and provider behavior are coherent.
- [ ] OpenRouter + Anthropic + OpenAI Codex all work as intended.
- [ ] The CLI is stable, safe, and debuggable.
- [ ] The TUI is polished enough for daily interactive use.
- [ ] The extension system is integrated, documented, and pleasant.
- [ ] Skills/packages/themes/prompts make the system adaptable beyond coding.
- [ ] Sessions/branching/export/recovery are trustworthy.
- [ ] Permissions and safety are enforced for risky actions.
- [ ] Documentation is accurate.
- [ ] Tests and CI provide real confidence.
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
- [ ] A high-level architecture diagram exists.
- [ ] Package boundaries and responsibilities are documented.
- [ ] The full request/turn lifecycle is documented end to end.
- [ ] The runtime data flow between CLI/TUI, core, AI, sessions, and extensions is documented.

### 19.2 Critical lifecycle walkthroughs
- [ ] Agent loop lifecycle is documented step by step.
- [ ] Session lifecycle is documented step by step.
- [ ] Tool execution lifecycle is documented step by step.
- [ ] Permission lifecycle is documented step by step.
- [ ] Auth and model resolution lifecycle is documented step by step.
- [ ] Extension lifecycle is documented step by step.
- [ ] TUI render/update/input lifecycle is documented step by step.

### 19.3 Architecture decision records
- [ ] ADRs exist for all important structural decisions.
- [ ] Each ADR includes:
  - [ ] problem statement
  - [ ] alternatives considered
  - [ ] tradeoffs
  - [ ] why the chosen approach won
  - [ ] when the decision should be revisited
- [ ] ADRs exist for at least:
  - [ ] auth strategy
  - [ ] model registry design
  - [ ] session format
  - [ ] compaction strategy
  - [ ] permission model
  - [ ] extension trust model
  - [ ] CLI/TUI architecture
  - [ ] resource model (prompts/skills/packages/themes)

---

## 20. Observability, Tracing, and Replay

### 20.1 Debug tracing
- [ ] Structured debug tracing exists for the full agent lifecycle.
- [ ] Tracing can be enabled without source edits.
- [ ] Tracing can be scoped by subsystem.
- [ ] Tracing is safe to use without leaking secrets.

### 20.2 Trace coverage
- [ ] Each turn can emit trace details for:
  - [ ] prompt assembly
  - [ ] model resolution
  - [ ] auth resolution
  - [ ] permission checks
  - [ ] tool calls
  - [ ] retries
  - [ ] compaction/summarization decisions
  - [ ] extension events and middleware
  - [ ] UI-level action transitions where relevant

### 20.3 Replay harness
- [ ] Session/transcript replay exists.
- [ ] Replay can run in fixture/mock mode.
- [ ] Replay can reproduce tool interactions deterministically where practical.
- [ ] Replay can show a readable timeline of what happened.
- [ ] Replay is useful for post-mortem debugging of real sessions.

---

## 21. Evaluation and Regression Harness

### 21.1 Task suites
- [ ] A curated coding task suite exists.
- [ ] A curated non-coding task suite exists.
- [ ] The task suite includes easy, medium, and failure-prone scenarios.

### 21.2 Regression coverage
- [ ] Golden transcripts or expected outcomes exist for critical behaviors.
- [ ] Changes to prompts, tools, auth, sessions, and compaction can be regression-tested.
- [ ] Provider/model behavior can be compared on the same tasks.

### 21.3 Evaluation outputs
- [ ] Eval reports capture:
  - [ ] correctness
  - [ ] tool-use quality
  - [ ] latency
  - [ ] token usage
  - [ ] cost
  - [ ] failure modes
- [ ] There is a documented process for using evals before major architecture or prompt changes.

---

## 22. Failure Injection and Chaos Testing

### 22.1 Auth and provider failures
- [ ] OAuth expiry can be simulated on demand.
- [ ] invalid/expired credentials can be simulated.
- [ ] provider 429s can be simulated.
- [ ] provider 5xx responses can be simulated.
- [ ] malformed/partial stream responses can be simulated.
- [ ] network interruption can be simulated.

### 22.2 Runtime failures
- [ ] tool timeouts can be simulated.
- [ ] tool cancellation can be simulated.
- [ ] concurrent auth/session writes can be simulated.
- [ ] partial session writes can be simulated.
- [ ] disk-full conditions can be simulated.
- [ ] extension crashes during startup, dispatch, tool middleware, and shutdown can be simulated.

### 22.3 Recovery discipline
- [ ] The expected recovery behavior for each injected failure is documented.
- [ ] The recovery behavior is test-covered.
- [ ] No known catastrophic failure path remains undocumented.

---

## 23. Prompt and Behavioral Architecture

### 23.1 Prompt composition
- [ ] The system prompt is documented section by section.
- [ ] Prompt assembly order is documented.
- [ ] All prompt/context sources are documented:
  - [ ] base instructions
  - [ ] project context
  - [ ] templates
  - [ ] skills/resources
  - [ ] extension context
  - [ ] session history
  - [ ] summaries/compaction output

### 23.2 Behavioral assumptions
- [ ] Prompt-encoded behavioral assumptions are documented.
- [ ] Safety constraints encoded in prompts are documented.
- [ ] The repo explains which behaviors come from code vs prompts.

### 23.3 Prompt quality control
- [ ] Prompt regressions are testable.
- [ ] Prompt changes are validated against the eval suite.
- [ ] There are examples showing how prompt architecture changes downstream behavior.

---

## 24. Capability Matrix and Fallback Policy

### 24.1 Capability matrix
- [ ] A provider/model capability matrix exists.
- [ ] The matrix includes:
  - [ ] tools
  - [ ] streaming
  - [ ] images
  - [ ] reasoning/thinking
  - [ ] context window
  - [ ] auth type
  - [ ] expected rate-limit profile
  - [ ] known quirks or incompatibilities

### 24.2 Fallback semantics
- [ ] Fallback behavior is documented when:
  - [ ] a model lacks tools
  - [ ] a model lacks reasoning
  - [ ] a provider loses auth
  - [ ] a stream fails mid-turn
  - [ ] a configured model disappears or becomes unavailable
- [ ] Capability mismatches are surfaced clearly in CLI/TUI UX.

---

## 25. Performance and Cost Profiling

### 25.1 Performance visibility
- [ ] Startup time is measured.
- [ ] session load time is measured.
- [ ] first-token latency is measured.
- [ ] full-turn latency is measured.
- [ ] tool latency is measured.
- [ ] compaction latency is measured.
- [ ] long-session memory usage is measured.

### 25.2 Cost visibility
- [ ] Token usage per turn is inspectable.
- [ ] Cost per turn is inspectable.
- [ ] Cost anomalies are easy to identify.
- [ ] The most expensive flows are documented.

### 25.3 Performance budgets
- [ ] Performance budgets exist for critical interactive flows.
- [ ] Regressions against those budgets are detectable.

---

## 26. CLI/TUI State-Model Documentation

### 26.1 CLI state model
- [ ] REPL input lifecycle is documented.
- [ ] one-shot execution lifecycle is documented.
- [ ] RPC lifecycle is documented.
- [ ] abort behavior is documented.

### 26.2 TUI state model
- [ ] TUI state transitions are documented.
- [ ] overlay/modal lifecycle is documented.
- [ ] login-flow UI states are documented.
- [ ] permission-prompt UI states are documented.
- [ ] tool-execution UI states are documented.
- [ ] session/branch-switch UI states are documented.

### 26.3 Learning bar
- [ ] A future maintainer can understand the UI state model without reverse-engineering the implementation.

---

## 27. Maintenance, Upgrade, and Extension-Authoring Playbooks

### 27.1 Maintenance playbooks
- [ ] There is a documented process for adding a new provider.
- [ ] There is a documented process for adding a new model family.
- [ ] There is a documented process for changing session format safely.
- [ ] There is a documented process for changing prompt architecture safely.
- [ ] There is a documented process for changing extension APIs safely.
- [ ] Dependency upgrade strategy is documented.
- [ ] TUI dependency upgrade strategy is documented.

### 27.2 On-the-fly extension authoring
- [ ] A canonical extension starter template exists.
- [ ] A compact extension API reference exists in a format the agent can target reliably.
- [ ] There is a prompt template or workflow for generating new extensions.
- [ ] Extension examples include:
  - [ ] command-only extension
  - [ ] tool-only extension
  - [ ] middleware/interceptor extension
  - [ ] non-coding workflow extension
- [ ] Extension debugging guidance exists.
- [ ] Extension hot-reload workflow exists for development.

### 27.3 Long-term adaptability
- [ ] Future-you can add a meaningful new capability without guessing how the internals work.
- [ ] The codebase remains teachable as well as usable.

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
