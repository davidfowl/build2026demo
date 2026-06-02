# Build 2026 Aspire agents demo

This repo is a compact demo for the thesis: **Aspire gives developers and agents a shared, executable model of the app.**

The app is a calendar planner. Dragging a block creates a planning intent. A background planner proposes structured `CalendarPatch[]` changes. The calendar broker/API validates ownership, policy, etags, and allowed operations before applying changes or holding them for confirmation.

## Run the plain app first

```bash
npm install
npm run plain:api
npm run plain:planner
npm run plain:web
```

That works, but startup order, URLs, logs, and demo operations are ad hoc.

## Run with Aspire

```bash
aspire start --isolated
```

Aspire models:

- `web` — React/Vite calendar UI.
- `api` — Express calendar broker and fake calendar provider.
- `postgres` / `calendar` — Aspire-managed PostgreSQL backing store for calendar state, intents, proposals, decisions, and audit history.
- `pgweb` — dashboard-launchable PostgreSQL inspection UI.
- `planner` — background planner/agent worker.
- `aca` — Azure Container Apps deployment environment for the stable app services.
- Dashboard HTTP commands on `api`: seed calendar, trigger replanning, replay last drag, simulate stale etag conflict, clear pending patches, reset calendar, inspect agent session.

## Demo beats

1. Drag a focus/task/draft block: broker auto-applies because it is user-owned and safe, with undo.
2. Drag the meeting: planner proposes the move, broker marks it `needs-confirmation`.
3. Drag the shared team block or run **Simulate stale etag conflict**: broker rejects the patch.
4. Inspect the agent session: hosted-agent isolation keys are visible, but the broker remains the calendar authorization boundary.
5. Move the planner to the Foundry-hosted-agent model when you want to show the managed agent runtime:

```bash
ENABLE_FOUNDRY_HOSTED_AGENT=true aspire start --isolated
```

That adds `foundry`, a `calendar-planning` project, a `chat` model deployment, a prompt agent, and publishes the planner as a Foundry hosted agent. The default local run leaves this off so the first half of the demo is reliable offline.

6. Deploy shape:

```bash
aspire publish
aspire deploy
```

The Vite frontend publishes as a static website with an `/api` proxy to the broker, while the API and planner are stable app services suitable for Azure Container Apps. Stateful planner execution can move to Foundry hosted agents without giving the agent calendar write authority.
