# Build 2026 Aspire agents demo

This repo is a compact demo for the thesis: **Aspire gives developers and agents a shared, executable model of the app.**

The app is a meeting-readiness planner. Booking a meeting applies a broker-validated calendar patch, then automatically starts a long-running agent job that uses app-provided tools to inspect the meeting, scan a 7-day calendar window, check Python-backed weather, estimate travel/setup time, and review agenda/materials. Calendar-changing suggestions still flow through structured `CalendarPatch[]` proposals, and the calendar broker validates ownership, policy, etags, and allowed operations before applying anything.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts the whole app through the Aspire AppHost in isolated mode and returns to the prompt. Use the dashboard URL printed by Aspire to open the app, inspect resources, and run demo commands.

```bash
npm run stop
```

Local development has one supported entrypoint: the AppHost. Do not start individual services for the demo; Aspire wires ports, Postgres, the Python weather sidecar, the planner, browser logs, and dashboard commands.

## Deploy

```bash
npm run deploy
```

Deployment uses the same AppHost. The app always includes the `planner-agent` hosted-agent resource; it is modeled with `asHostedAgent(...)` and deploys as the Foundry hosted-agent runtime.

## Aspire model

- `web` — React/Vite 7-day calendar UI with meeting-readiness suggestions.
- `api` — Express calendar broker and fake calendar provider.
- `weather` — Python/FastAPI sidecar that returns deterministic meeting-day forecasts for readiness advice.
- `postgres` / `calendar` — Aspire-managed PostgreSQL backing store for calendar state, readiness jobs, intents, proposals, decisions, and audit history.
- `pgweb` — dashboard-launchable PostgreSQL inspection UI.
- `planner` — background worker that runs readiness tools and invokes the planner-agent endpoint.
- `aca` — Azure Container Apps deployment environment for stable services.
- `planner-agent` — Copilot SDK-backed hosted-agent resource modeled with `asHostedAgent(...)`.
- `foundry` / `calendarplanning` / `chat` — Foundry project and model resources backing the hosted agent.

## Demo beats

1. Drag across an open time range on the calendar, adjust the draft meeting details, and book **Build keynote readiness review**.
2. Watch the readiness job progress through meeting details, 7-day calendar scan, Python weather, travel/setup, agenda/materials, and scoring.
3. Review the returned suggestions: book prep time, plan for weather, hold travel/setup buffer, and bring the demo checklist.
4. Accept a calendar-changing suggestion: the broker validates the agent's `CalendarPatch` before adding the prep or travel block.
5. Hover a meeting, click the trash button, and approve the delete modal to show destructive changes still run through broker validation.
6. Open the dashboard to show the same executable model handles local orchestration, logs, health, commands, data, and deployment.
