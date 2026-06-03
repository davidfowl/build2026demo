# Build 2026 Aspire agents demo

This repo is a compact demo for the thesis: **Aspire gives developers and agents a shared, executable model of the app.**

The app is a meeting-readiness planner. Booking a meeting applies a broker-validated calendar patch, then automatically starts a long-running agent job that uses app-provided tools to inspect the new meeting, scan a 7-day calendar window, check weather, estimate travel/setup time, and review agenda/materials. The agent returns readiness suggestions. Calendar-changing suggestions still flow through structured `CalendarPatch[]` proposals, and the calendar broker/API validates ownership, policy, etags, and allowed operations before applying anything.

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

- `web` — React/Vite 7-day calendar UI with meeting-readiness suggestions.
- `api` — Express calendar broker and fake calendar provider.
- `postgres` / `calendar` — Aspire-managed PostgreSQL backing store for calendar state, readiness jobs, intents, proposals, decisions, and audit history.
- `pgweb` — dashboard-launchable PostgreSQL inspection UI.
- `planner` — background planner/agent worker that runs readiness tools and emits suggestions.
- `aca` — Azure Container Apps deployment environment for the stable app services.
- Dashboard HTTP commands on `api`: seed calendar, generate a Build-themed week, clear calendar events, trigger meeting readiness, simulate stale etag conflict, inspect agent session.

## Demo beats

1. Drag across an open time range on the calendar, adjust the draft meeting details, and book **Build keynote readiness review**.
2. Watch the readiness job automatically progress through meeting details, 7-day calendar scan, weather, travel/setup, agenda/materials, and scoring.
3. Review the returned suggestions: book prep time, plan for rain, hold travel/setup buffer, and bring the demo checklist.
4. Accept a calendar-changing suggestion: the broker validates the agent's `CalendarPatch` before adding the prep or travel block.
5. Hover a meeting, click the trash button, and approve the delete modal to show destructive changes still run through broker validation.
6. Run **Simulate stale etag conflict** to show the same broker boundary still rejects unsafe patches.
7. Inspect the agent session: hosted-agent isolation keys are visible, but the broker remains the calendar authorization boundary.
8. Move the planner to the Foundry-hosted-agent model when you want to show the managed agent runtime:

```bash
ENABLE_FOUNDRY_HOSTED_AGENT=true aspire start --isolated
```

That adds `foundry`, a `calendar-planning` project, a `chat` model deployment, a prompt agent, and publishes the planner as a Foundry hosted agent. The default local run leaves this off so the first half of the demo is reliable offline.

8. Deploy shape:

```bash
aspire publish
aspire deploy
```

The Vite frontend publishes as a static website with an `/api` proxy to the broker, while the API and planner are stable app services suitable for Azure Container Apps. Stateful planner execution can move to Foundry hosted agents without giving the agent calendar write authority.
