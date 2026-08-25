# ADR 0001: DSH-first reuse policy

- Status: Accepted
- Date: 2026-08-24
- Owners: AI Native Game Harness

## Context

AI Native Game Harness is a game-focused product and orchestration layer built with DeepSeek Harness (DSH), not a replacement for DSH's general Agent runtime. The migrated XiaoTangYuan plugin has already validated DSH model selection, credentials, Agent sessions, Tool Calling, streaming replies, memory, multimodal routing and plugin lifecycle.

Keeping `harness-core` and the Game Adapter Protocol free of DSH types is a dependency-boundary and testability decision. It does not mean that the shipped product should replace DSH or use a standalone Agent runtime by default.

## Decision

The product follows a **DSH-first** strategy:

1. Reuse DSH for models, providers, credentials, Agent sessions, Tool Calling, settings, approvals, generic logs and plugin lifecycle.
2. Implement game-specific concerns in this project: authoritative game observations, action validation, revision control, Game Adapter Protocol, Game Packs, game analysis UI and game connection diagnostics.
3. Use `dsh-binding` as the default product integration between DSH Agent sessions and the game-focused Harness Core.
4. Keep the standalone Mock Agent and standalone Platform Runtime as conformance tests and development fixtures, not as the intended default product runtime.
5. Build a replacement only after a concrete DSH mismatch is demonstrated and recorded.

The same rule applies to the product client surface:

- DSH Session APIs, durable events and registered projections are the canonical source for generic Agent state and timing.
- A product page outside the composed DSH Web client may keep a thin transport and presentation bridge, but it must not create a second Session store or independently redefine canonical DSH metrics.
- DSH Web client plugins are reusable only inside their declared client composition. Their existence does not imply that a standalone Electron page can instantiate package-internal controllers or React views directly.
- The DSH client connection and the Game Adapter connection are separate boundaries. Only the latter belongs to this project's public cross-process game protocol.

## Replacement gate

A custom replacement for a DSH capability requires all of the following evidence:

- the exact DSH capability and version were inspected;
- the game use case and required behavior are written down;
- a reproducible test proves the mismatch or missing capability;
- extending DSH through its plugin protocol was considered first;
- the replacement is the smallest isolated component that closes the gap;
- DSH and game end-to-end regression tests remain green.

Convenience, unfamiliarity or the existence of a framework-neutral interface is not sufficient evidence to replace DSH.

## Consequences

- The DSH Agent session/tool loop is connected to `HarnessCore` action/action-result handling and has passed the Mock Game smoke test.
- A direct OpenAI-compatible Agent Driver is not current roadmap work unless the replacement gate is satisfied.
- The current standalone Desktop path remains useful for deterministic protocol testing, but the intended product default is the embedded, version-pinned DSH runtime.
- The next integration task is to repeat the same authoritative-result and product-page acceptance with a real game.
- Documentation and tests must distinguish the product default, the standalone test fixture, DSH Host capabilities, DSH Web-only client plugins and the external Game Adapter boundary.
