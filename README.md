# Cursor–ChatGPT Controller

**Sanitized infrastructure snapshot · October 2026**

This project records a Windows-first engineering orchestration system that uses a ChatGPT Controller to commission work through an existing Cursor Desktop Agent, collect structured evidence and trigger review notifications. It is an **infrastructure code snapshot**, not a backup of its operator's projects or conversations.

## Workflow

```text
Manifest JSON + task prompt Markdown
              |
     Parameterized one-command dispatcher
              |
   Batch registration / immutable Envelope
              |
    Validate -> GUI preflight -> one-shot send
              |
   Local Cursor CDP -> existing Cursor Agent
              |
      Handoff -> Collection -> Review
              |
       Batch ledger / state transition
              |
  Local relay -> Edge extension -> ChatGPT
```

## Included

- `controller-dispatch-task.js`: declarative task entry point, envelope verification, Batch registration and durable send intent.
- `cursor-primary-task-runner.js`: formal one-shot dispatcher with normalized user-transcript confirmation.
- `cursor-primary-cdp-driver.js`, `cursor-model-profile.js`, `cursor-cdp-isolated-driver.js`: local GUI and exact model/context/reasoning/Fast configuration.
- `controller-loop.js`, `batch-supervisor.js`, `batch-gate.js`: state, collection and review controls.
- `visible-tab-relay.js`, `focus-free-bridge.js`, `focus-free-transport.js`, `edge-visible-extension/`: controlled same-project notification bridge.
- `cursor-primary-cdp-cutover.ps1`: **portable verify-only** process/profile/CDP ownership guard. No automatic restart/termination capability is included.
- Schema files, an example manifest and example prompt.

## Requirements and setup

This is a **reference snapshot, not a turnkey installer**. It requires Windows, a compatible Cursor desktop version, an already-authorized local environment, Node.js 22+ and a loopback-only CDP endpoint. Runtime dependencies and UI selectors require verification on the receiving host.

Before use, set `CONTROLLER_WORKSPACE` to a workspace you own. Set `CURSOR_AGENT_TRANSCRIPTS_DIR` to your Cursor agent-transcripts folder or `CURSOR_PROJECT_SLUG` to the corresponding directory name; `CURSOR_CDP_PORT` defaults to `41383`.

Example dry-run (does not send):

```powershell
$env:CONTROLLER_WORKSPACE = 'C:\\path\\to\\workspace'
node controller-dispatch-task.js plan EXAMPLE_CONTROLLER_TASK_0001
```

For a real task, first create unique, never-reused task IDs, an authorized OPEN Batch and a strict write allowlist, and configure the local Cursor guard. `node controller-dispatch-task.js run YOUR_UNIQUE_TOKEN` will then use the original formal dispatcher. **Do not retry a token after a send attempt or ambiguous submission.**

The Edge extension must be explicitly bound to the intended ChatGPT Project conversation. It is not a general-purpose background browser automation API.

## Safety and release boundaries

**Not included:** private event queues, actual dispatch Envelopes, Batch history, Collections, Reviews, Handoffs, model transcripts, local process IDs, live URLs, browser profiles, tokens, API keys, project files and task logs.

This snapshot replaces host-specific paths with environment configuration and includes only the verified source-code allowlist. It is not a claim that all failure modes or long-running autonomous recovery have been resolved. Tool budget enforcement and cross-session reliability remain areas for improvement.

See [SECURITY.md](SECURITY.md). No API key, external model endpoint or Cursor CLI is required by the design: it operates through the user's existing authorized Cursor GUI.
