# Build 2026 progressive demo flow

## The promise

**Aspire gives both developers and agents a shared, executable model of the app.**

Do not start by showing every service, command, and deployment target. Start with a simple calendar interaction, then progressively reveal the distributed system hiding behind it. The audience should feel the app grow from "a normal web app" into an agentic distributed app, with Aspire becoming the thing that keeps it understandable.

## Progressive disclosure rule

Each chapter should reveal exactly one new layer.

| Reveal | Audience starts thinking | Then you show |
| --- | --- | --- |
| Calendar UI | "This is just a planner." | Booking a meeting starts a broker write and a meeting-readiness job. |
| Readiness job | "The agent will prepare me." | The agent runs app-provided tools: meeting details, 7-day calendar, weather, travel, agenda/materials. |
| Broker policy | "So who is allowed to write?" | Calendar-changing suggestions become structured `CalendarPatch[]` proposals that the broker validates. |
| Durable state | "Where does this coordination live?" | Aspire-managed PostgreSQL stores state, readiness jobs, proposals, decisions, and audit history. |
| Aspire graph | "This is already a distributed system." | `web`, `api`, `planner`, commands, logs, health, and relationships in one AppHost. |
| Resource commands | "How do I run and debug this reliably?" | Reset, trigger readiness, replay, simulate conflict, inspect session. |
| Foundry hosted agents | "Where should model-backed agent execution live?" | Stable services stay in ACA; stateful readiness sessions move to Foundry hosted agents. |
| Deployment | "Does this model survive production?" | Aspire publishes and deploys the same app model. |

## 45-minute arc

| Time | Chapter | What is visible | Reveal |
| --- | --- | --- | --- |
| 0-5 min | Hook | One calendar screen. | "Agentic apps become distributed systems fast." |
| 5-10 min | Plain app | Three manual processes or terminals. | The app works, but startup, config, logs, and operations are ad hoc. |
| 10-16 min | First Aspire reveal | Dashboard resource graph. | Aspire turns the app into a code-first executable model. |
| 16-24 min | Agentic interaction | Book a meeting and watch readiness start. | The agent runs multiple tools and returns practical suggestions. |
| 24-31 min | Safety and durability | Suggested prep/travel blocks, rejected patches, Postgres/pgweb. | The broker owns authorization, and Postgres records the durable coordination trail. |
| 31-36 min | Operability | Dashboard logs/traces and HTTP commands. | Aspire gives repeatable demo/debug operations for humans and agents. |
| 36-42 min | Hosted agents and cloud | Foundry model path and ACA deployment preview. | Use the right runtime for each part of the distributed app. |
| 42-45 min | Close | AppHost code. | Aspire is the app control plane in code. |

## Presenter runbook

### 1. Start with the calendar, not Aspire

Keep the Aspire dashboard hidden. Show only the browser and say:

> This starts like a normal scheduling feature: I book a meeting and expect the app to help me show up prepared.

Drag across an open time range on the calendar to place the draft meeting, adjust the details, and book **Build keynote readiness review**. Let the audience see the meeting appear and the job start automatically, then point to the progress card. The important reveal is that the UI did not ask the agent to mutate the calendar. A user booking went through the broker, and only then did the app create a meeting-readiness job.

Call out the first boundary:

```text
meeting booking -> broker create patch -> readiness job
```

### 2. Reveal the planner as a separate actor with tools

Now explain that an agent/planner is watching the readiness queue. It does not receive a calendar write token. It receives app-provided tools and emits suggestions:

```text
readiness job -> meeting/calendar/weather/travel/materials tools -> suggestions
```

Use the local deterministic planner for reliability, but describe it as the same contract the model-backed planner uses later. Be explicit: the local path proves the architecture; the Foundry chapter is where model-backed hosted execution belongs.

### 3. Reveal the broker as the safety boundary

Accept the prep-time or travel/setup suggestion. It should not be a hidden direct write. Show that the suggestion is converted into a structured patch and the broker validates it before adding a calendar block.

Then show one rejection path:

```text
CalendarPatch[] -> broker policy -> apply | needs-confirmation | reject
```

This is the central agentic-app lesson: the model can reason and use tools, but the app owns authorization. The broker validates user ownership, calendar scope, operation type, etags, stale state, and allowed mutations.

### 4. Reveal durable coordination in Postgres

Open the Postgres/pgweb resource from the Aspire dashboard after showing the broker decision. Show that state is no longer a hidden local JSON file. The broker persists the current calendar state plus readiness jobs, proposals, decisions, and audit entries in an Aspire-managed PostgreSQL database.

Use this line:

> Agentic coordination needs durable state: what the user asked for, which tools the agent ran, what it suggested, what policy decided, and what actually changed.

### 5. Only now reveal Aspire

Open the Aspire dashboard after the audience has seen the user interaction and the policy problem. The resource graph now has narrative weight:

| Resource | Why it exists |
| --- | --- |
| `web` | 7-day calendar UI and meeting-readiness cards. |
| `api` | Calendar broker, fake calendar/readiness provider, policy, audit trail, SSE. |
| `postgres` / `calendar` | Durable app state for calendar events, readiness jobs, proposals, decisions, and audit history. |
| `pgweb` | Inspectable Postgres UI from the dashboard. |
| `planner` | Background planner/agent worker that runs readiness tools and proposes patches. |
| `aca` | Deployment environment for stable app services. |
| Foundry resources | Optional hosted-agent runtime for model-backed planning sessions. |

Say:

> Aspire did not just start my services. It gave the developer and the agent a shared executable model of what this app is, including the database.

### 6. Use resource commands for the inner loop

Frame these commands strictly as local inner-loop helpers. They are not the product surface and they are not the production agent runtime. They make development and rehearsal fast because the app model carries repeatable operations for seeding, generating, clearing, conflict simulation, and inspection.

First use one command from the Aspire dashboard, then run the same kind of operation from the Aspire CLI to show that inner-loop operations are part of the executable app model rather than one-off scripts.

```bash
aspire describe api
aspire resource api inspect-agent-session --apphost ./apphost.mts
aspire resource api generate-build-week-calendar --apphost ./apphost.mts
aspire resource api clear-calendar-events --apphost ./apphost.mts
aspire resource api trigger-meeting-readiness --apphost ./apphost.mts
aspire resource api simulate-calendar-conflict --apphost ./apphost.mts
```

| Command | CLI name | Inner-loop reason |
| --- | --- | --- |
| Seed demo calendar | `seed-demo-calendar` | Return Postgres to the seeded 7-day scenario. |
| Generate Build week calendar | `generate-build-week-calendar` | Replace the calendar with a believable randomized Build-themed week. |
| Clear calendar events | `clear-calendar-events` | Start from an empty calendar while preserving an audit entry. |
| Trigger meeting readiness | `trigger-meeting-readiness` | Exercise the long-running readiness agent without manual UI setup. |
| Simulate stale etag conflict | `simulate-calendar-conflict` | Optional safety-boundary proof on demand. |
| Inspect agent session | `inspect-agent-session` | Inspect local/hosted planner configuration while developing. |

The point is inner-loop DevEx: commands, logs, resource state, relationships, and operational affordances are discoverable from the app model and callable from tooling while you build and debug.

### 7. Reveal why hosted agents matter

Do not position Azure Container Apps as the place to run arbitrary stateful agent sessions. Use ACA for stable app services: web/API/planner worker. Then explain the pressure that appears when the planner becomes a real model-backed coding/agent session:

| Concern | If you own it in ACA | Hosted-agent story |
| --- | --- | --- |
| Filesystem state | You manage cleanup and isolation. | Per-session sandbox. |
| User state | You partition storage and HOME. | Persistent HOME per session. |
| Security | You manage per-user boundaries. | Isolation keys partition hosted sessions. |
| Idle behavior | You build lifecycle management. | Agent runtime owns the session lifecycle. |
| App authority | Easy to accidentally over-grant. | Broker still owns calendar writes. |

Then show the opt-in hosted-agent shape:

```bash
ENABLE_FOUNDRY_HOSTED_AGENT=true aspire start --isolated
```

The key line:

> Foundry changes where planning runs. It does not change who is allowed to write the calendar.

### 8. End with deployment from the same model

Preview deployment without turning the final minutes into cloud plumbing:

```bash
aspire publish --list-steps
aspire deploy --list-steps
```

Make the split clear:

| Part | Deployment posture |
| --- | --- |
| Web/API/stable worker | Azure Container Apps through Aspire. |
| Model-backed planning sessions | Foundry hosted agents. |
| Calendar writes | Still broker-authorized. |
| App topology | Still defined in the AppHost. |

## Exact local flow

1. Reset to a known state with the dashboard command or API command.
2. Show the browser only.
3. Drag across an open time range on the calendar, adjust the New meeting details, and book **Build keynote readiness review**.
4. Narrate each automatically started readiness progress step.
5. Review suggestions for prep time, weather/attire, travel/setup, and agenda/materials.
6. Accept the prep-time suggestion and show the broker-applied prep block.
7. Hover a meeting, click the trash button, and approve the delete modal to show destructive changes still run through broker validation.
8. Simulate stale etag conflict and show rejection.
9. Open Aspire dashboard and reveal `web`, `api`, `planner`, and Postgres.
10. Open pgweb to show durable readiness state and audit history.
11. Search logs/traces for the readiness job or proposal id.
12. Run one inner-loop command from the dashboard, then the same class of command from the CLI with `aspire resource api trigger-meeting-readiness`.
13. Show `apphost.mts` as the code-first model that defines the app resources and local development command surface.
14. Preview Foundry hosted-agent mode.
15. Preview ACA deployment steps.

## What not to reveal too early

| Hide until | Reason |
| --- | --- |
| Full resource graph | It lands better after the audience sees why the app is distributed. |
| Postgres | It matters more after the audience sees readiness jobs, suggestions, proposals, and decisions. |
| All dashboard commands | Commands are more compelling after something needs replay/debug/reset. |
| Foundry hosted agents | First establish the app/broker safety boundary. |
| Deployment | Save cloud readiness for the "same model goes to prod" payoff. |
| Implementation details | The story is the app model and safety boundary, not calendar mechanics. |

## Policy moments to call out

| Calendar change | Broker decision |
| --- | --- |
| Create accepted prep/travel block | Apply after the user accepts and the broker re-validates the patch. |
| Move user-owned focus/task/draft block | Apply automatically with undo. |
| Move accepted meeting with attendees | Require confirmation. |
| Delete event | Require confirmation. |
| Change attendees, location, or description | Require confirmation. |
| Shared/team calendar change | Block or require stronger authorization. |
| Stale etag/conflict | Reject and re-plan or ask the user. |

## Closing line

The old impression was ".NET Aspire" as local orchestration. The new impression is Aspire as a product for modern distributed apps: polyglot, cloud-ready, and agent-ready. It gives developers and agents the same executable map of the system, from local dev to deployment.
