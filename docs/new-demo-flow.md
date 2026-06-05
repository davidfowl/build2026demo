# Demo runbook

## One way to run locally

```bash
npm install
npm run dev
```

`npm run dev` starts the Aspire AppHost in isolated mode. That one command starts the React app, Express broker, Python weather service, planner worker, Postgres, and pgweb with randomized ports and dashboard wiring. The AppHost always includes the Copilot SDK-backed `planner-agent` as a Foundry hosted-agent resource through `asHostedAgent(...)`.

Use the dashboard URL printed by Aspire. Stop the whole app with:

```bash
npm run stop
```

Do not run the individual services directly for the demo. The point is that Aspire owns startup order, resource health, URLs, logs, telemetry, and repeatable commands from one executable app model.

## Demo story

1. Open the web app from the Aspire dashboard.
2. Book a meeting and watch readiness start automatically.
3. Show the planner steps: meeting details, calendar window, Python weather, travel/setup, agenda/materials, scoring.
4. Accept a suggested prep or travel block and show the broker-authorized calendar write.
5. Open the dashboard and reveal the resources behind the interaction.
6. Open pgweb to show durable readiness, proposals, decisions, and audit state.
7. Use one dashboard command, such as **Set demo calendar** or **Clear calendar**, to show repeatable inner-loop operations.
8. Show `apphost.mts` as the single model for local orchestration and deployment.

## One way to deploy

```bash
npm run deploy
```

Deployment uses the same AppHost to target Azure Container Apps for stable services while publishing the Copilot SDK `planner-agent` as the Foundry hosted-agent runtime.
