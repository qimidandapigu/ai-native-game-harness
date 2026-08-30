# DSH Work Orchestrator

`@qimidandapigu/dsh-work-orchestrator` is a reusable DeepSeek Harness plugin for companion products.

It runs after a companion has already answered, recognizes substantial non-game work, creates or resumes a separate Worker, and relays public progress or results back through the original companion Session.

Every task first runs in a real, visible Worker DSH Session, so ChatList shows titles such as `[Work · 执行中] 汇报 HTML`. Codex App Server is an optional nested executor: it is used only when the player explicitly asks the Work Session to use Codex. In that case the title becomes `[Work → Codex · 执行中] 汇报 HTML`, while the Worker DSH Session remains the durable owner of context, progress, and reporting.

It deliberately does not introduce a task-creation tool or a second task UI. Players keep using natural conversation to start work, ask for the current approach, and give revision feedback.

## Boundary

- DeepSeek Harness owns recognition, the real Worker Session, model routing, persistence, optional executor delegation, and companion relay.
- Codex App Server may own execution, streamed turn events, and resumable Codex Thread history.
- This plugin owns post-turn recognition and the companion-to-Worker association.
- The calling companion owns its identity and final user-facing wording.
- Desktop or game clients may display notifications, but they are not the source of truth for work state.

## Companion integration

Inject the `workOrchestrator` Cordis service and call `scheduleTurn()` only after the companion reply has completed. Pass a companion profile to customize Worker and relay wording without coupling this plugin to a specific character.

Existing `xiaotangyuan-work-*` associations and `work-session-links-v1.json` records are accepted during migration.

## Executor configuration

```yaml
- id: work-orchestrator
  config:
    codex:
      executable: codex
      reasoningEffort: high
```

There is intentionally no global executor switch: every new task starts in a real Worker DSH Session. Codex is used only when the player explicitly asks for it in that task or a later revision. On Windows, the client also discovers the Codex Desktop CLI under `%LOCALAPPDATA%/OpenAI/Codex/bin` when `codex` is not directly resolvable from `PATH`. Codex runs with `workspace-write` and `approvalPolicy: never` inside the configured Work Orchestrator workspace.
