import { FoundryModels, HttpCommandResultMode, createBuilder } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();

const aca = await builder.addAzureContainerAppEnvironment('aca');
const postgres = builder.addPostgres('postgres').withDataVolume().withPgWeb();
const calendarDb = postgres.addDatabase('calendar');
const plannerMode = builder.addParameter('plannerMode', { value: 'local', publishValueAsDefault: true });
const foundryUserIsolationKey = builder.addParameter('foundryUserIsolationKey', { value: 'user-alex', publishValueAsDefault: true });
const foundryChatIsolationKey = builder.addParameter('foundryChatIsolationKey', { value: 'chat-build-2026', publishValueAsDefault: true });
const useFoundryHostedAgent = process.env.ENABLE_FOUNDRY_HOSTED_AGENT === 'true';
const foundry = useFoundryHostedAgent ? await builder.addFoundry('foundry') : undefined;
const foundryProject = foundry ? await foundry.addProject('calendar-planning') : undefined;
const chat = foundryProject ? await foundryProject.addModelDeployment('chat', FoundryModels.OpenAI.Gpt5Mini) : undefined;

if (foundryProject && chat) {
    await foundryProject.addPromptAgent('calendar-policy-planner', chat, {
        instructions: `
You are the meeting readiness agent for an Aspire Build 2026 demo.
Use app-provided tools to analyze prep time, weather/attire, travel buffer, and agenda/materials.
Return readiness suggestions. Include structured CalendarPatch proposals only for user-visible calendar suggestions.
Never call calendar write APIs directly.
The calendar broker validates ownership, permissions, stale etags, and confirmation policy.
`.trim(),
    });
}

const api = await builder
    .addNodeApp('api', './services/api', 'src/server.ts')
    .withRunScript('dev')
    .withComputeEnvironment(aca)
    .withEnvironment('CALENDAR_STORE', 'postgres')
    .withReference(calendarDb)
    .waitFor(calendarDb)
    .withHttpEndpoint({ name: 'http', env: 'PORT' })
    .withExternalHttpEndpoints()
    .withHttpCommand('/api/demo/seed', 'Seed demo calendar', {
        commandName: 'seed-demo-calendar',
        description: 'Reset the local fake calendar provider to the seeded Build 2026 scenario.',
        iconName: 'Calendar',
        isHighlighted: true,
        methodName: 'POST',
        endpointName: 'http',
        resultMode: HttpCommandResultMode.Json,
    })
    .withHttpCommand('/api/demo/generate-build-week', 'Generate Build week calendar', {
        commandName: 'generate-build-week-calendar',
        description: 'Replace the calendar with a believable randomized Build-themed week.',
        confirmationMessage: 'Replace the current calendar with a generated Build-themed week?',
        iconName: 'Calendar',
        isHighlighted: true,
        methodName: 'POST',
        endpointName: 'http',
        resultMode: HttpCommandResultMode.Json,
    })
    .withHttpCommand('/api/demo/clear-events', 'Clear calendar events', {
        commandName: 'clear-calendar-events',
        description: 'Remove all calendar events and clear readiness/proposal state.',
        confirmationMessage: 'Clear all calendar events and agent state?',
        iconName: 'Delete',
        isHighlighted: true,
        methodName: 'POST',
        endpointName: 'http',
        resultMode: HttpCommandResultMode.Json,
    })
    .withHttpCommand('/api/demo/trigger-readiness', 'Trigger meeting readiness', {
        commandName: 'trigger-meeting-readiness',
        description: 'Queue the long-running meeting readiness agent for the seeded Build 2026 review.',
        iconName: 'Bot',
        isHighlighted: true,
        methodName: 'POST',
        endpointName: 'http',
        resultMode: HttpCommandResultMode.Json,
    })
    .withHttpCommand('/api/demo/simulate-conflict', 'Simulate stale etag conflict', {
        commandName: 'simulate-calendar-conflict',
        description: 'Optional safety-boundary proof: create a stale-etag patch so the broker rejects it.',
        confirmationMessage: 'Create a stale proposal and reject it through broker policy?',
        iconName: 'Warning',
        isHighlighted: false,
        methodName: 'POST',
        endpointName: 'http',
        resultMode: HttpCommandResultMode.Json,
    })
    .withHttpCommand('/api/demo/agent-session', 'Inspect agent session', {
        commandName: 'inspect-agent-session',
        description: 'Show the Foundry hosted-agent isolation keys and latest request shape.',
        iconName: 'Bot',
        isHighlighted: true,
        methodName: 'POST',
        endpointName: 'http',
        resultMode: HttpCommandResultMode.Json,
    });

let planner = builder
    .addNodeApp('planner', './services/planner', 'src/worker.ts')
    .withRunScript('dev')
    .withEnvironment('API_BASE_URL', api.getEndpoint('http'))
    .withEnvironment('PLANNER_MODE', plannerMode)
    .withEnvironment('FOUNDRY_USER_ISOLATION_KEY', foundryUserIsolationKey)
    .withEnvironment('FOUNDRY_CHAT_ISOLATION_KEY', foundryChatIsolationKey)
    .waitFor(api);

if (foundryProject && chat) {
    planner = planner
        .withHttpEndpoint({ name: 'http', targetPort: 8088, env: 'DEFAULT_AD_PORT' })
        .withReference(foundryProject)
        .withReference(chat)
        .asHostedAgent(foundryProject, {
            description: 'Meeting readiness hosted-agent runtime. Emits suggestions and broker-reviewed CalendarPatch proposals.',
            cpu: 0.5,
            memory: 1,
            metadata: {
                demo: 'build-2026-aspire-agents',
                authority: 'calendar-broker',
            },
            environmentVariables: {
                PLANNER_MODE: 'foundry-hosted',
            },
            protocols: [{ protocol: 'responses', version: '1.0.0' }],
        });
}

await planner;

await builder
    .addViteApp('web', './apps/web')
    .withComputeEnvironment(aca)
    .withEnvironment('API_BASE_URL', api.getEndpoint('http'))
    .withReference(api)
    .waitFor(api)
    .withExternalHttpEndpoints()
    .publishAsStaticWebsite({ apiPath: '/api', apiTarget: api })
    .withBrowserLogs();

await builder.build().run();