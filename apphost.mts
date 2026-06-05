import {
    FoundryModels,
    HttpCommandResultMode,
    InputType,
    OtlpProtocol,
    createBuilder,
    type ExecuteCommandContext,
    type ExecuteCommandResult,
} from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();
const executionContext = await builder.executionContext();
const isRunMode = await executionContext.isRunMode();

const aca = await builder.addAzureContainerAppEnvironment('aca');
const calendarDatabaseName = 'calendar';
let postgres = builder
    .addPostgres('postgres')
    .withEnvironment('POSTGRES_DB', calendarDatabaseName);
if (isRunMode) {
    postgres = postgres.withDataVolume();
}
postgres = postgres
    .withComputeEnvironment(aca)
    .withPgWeb({ configureContainer: async (pgweb) => { await pgweb.withComputeEnvironment(aca); } });
const calendarDb = postgres.addDatabase(calendarDatabaseName);
const foundry = await builder.addFoundry('foundry');
const foundryProject = await foundry.addProject('calendarplanning');
const chat = await foundryProject.addModelDeployment('chat', FoundryModels.OpenAI.Gpt5Mini);
await chat.skuCapacity.set(10);

const weather = await builder
    .addUvicornApp('weather', './services/weather-python', 'main:app')
    .withUv()
    .withComputeEnvironment(aca)
    .withUrlForEndpoint('http', async (url) => {
        url.displayText = 'Python weather sidecar';
    });

await foundryProject.addPromptAgent('calendar-policy-planner', chat, {
    instructions: `
You are the meeting readiness agent for an Aspire Build 2026 demo.
Use app-provided tools to analyze prep time, weather/attire, travel buffer, and agenda/materials.
Return readiness suggestions. Include structured CalendarPatch proposals only for user-visible calendar suggestions.
Never call calendar write APIs directly.
The calendar broker validates ownership, permissions, stale etags, and confirmation policy.
`.trim(),
});

const api = await builder
    .addNodeApp('api', './services/api', 'dist/server.js')
    // Run mode watches TypeScript source; deployment builds the dist entrypoint above.
    .withRunScript('dev')
    .withBuildScript('build')
    .withComputeEnvironment(aca)
    .withEnvironment('CALENDAR_STORE', 'postgres')
    .withEnvironment('WEATHER_BASE_URL', weather.getEndpoint('http'))
    .withReference(calendarDb)
    .waitFor(calendarDb)
    .waitFor(weather)
    .withHttpEndpoint({ name: 'http', env: 'PORT' })
    .withHttpHealthCheck({ path: '/readiness' })
    .withUrlForEndpoint('http', async (url) => {
        url.displayText = 'Calendar broker API';
    })
    .withExternalHttpEndpoints();

await api.withCommand(
    'set-demo-calendar',
    'Set demo calendar',
    async (context: ExecuteCommandContext): Promise<ExecuteCommandResult> => {
        const args = await context.arguments();
        const mode = await args.requiredValue('mode');

        let path: string;
        let message: string;

        switch (mode) {
            case 'reset':
                path = '/api/demo/seed';
                message = 'Reset calendar to the seeded Build 2026 scenario.';
                break;
            case 'random':
                path = '/api/demo/generate-build-week';
                message = 'Generated a randomized Build-themed calendar week.';
                break;
            default:
                return { success: false, message: `Unsupported calendar mode '${mode}'.` };
        }

        const endpoint = await api.getEndpoint('http');
        const url = await endpoint.url();
        const response = await fetch(new URL(path, url), { method: 'POST' });

        if (!response.ok) {
            return {
                success: false,
                message: `Calendar broker API returned ${response.status} ${response.statusText}.`,
            };
        }

        return { success: true, message };
    },
    {
        commandOptions: {
            description: 'Choose whether to restore the seeded Build 2026 calendar or generate a randomized week.',
            iconName: 'Calendar',
            isHighlighted: true,
            arguments: [
                {
                    name: 'mode',
                    label: 'Calendar setup',
                    inputType: InputType.Choice,
                    required: true,
                    value: 'reset',
                    options: [
                        { key: 'reset', value: 'Reset to seeded Build 2026 scenario' },
                        { key: 'random', value: 'Generate random Build-themed week' },
                    ],
                },
            ],
        },
    },
);

await api.withHttpCommand('/api/demo/clear-events', 'Clear calendar', {
    commandName: 'clear-calendar',
    description: 'Remove all calendar events and clear readiness/proposal state.',
    confirmationMessage: 'Clear all calendar events and agent state?',
    iconName: 'Delete',
    isHighlighted: true,
    methodName: 'POST',
    endpointName: 'http',
    resultMode: HttpCommandResultMode.Json,
});

// planner-agent is the model-execution boundary. In local dev it runs
// services/planner/src/agent.ts as a Node app; when deployed, asHostedAgent(...)
// publishes it as a Foundry hosted-agent runtime that serves the invocations protocol.
const hostedAgent = builder
    .addNodeApp('planner-agent', './services/planner', 'dist/agent.js')
    .withNpm({ install: false })
    // Run mode watches the agent source; deployment builds the dist entrypoint above.
    .withRunScript('dev:agent')
    .withBuildScript('build:agent')
    .withEnvironment('COPILOT_OTEL_CAPTURE_CONTENT', 'true')
    .withEnvironment('COPILOT_OTEL_BSP_SCHEDULE_DELAY', '100')
    .withEnvironment('COPILOT_OTEL_FLUSH_DELAY_MS', '1500')
    .withEnvironment('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true')
    // Injects CHAT_* flattened model metadata used by the Copilot SDK provider.
    .withReference(chat)
    .asHostedAgent(foundryProject, {
        description: 'Meeting readiness hosted-agent runtime. Uses the Copilot SDK and emits broker-reviewed readiness suggestions and CalendarPatch proposals.',
        cpu: 0.5,
        memory: 1,
        metadata: {
            demo: 'build-2026-aspire-agents',
            authority: 'calendar-broker',
            runtime: 'copilot-sdk',
        },
        protocols: [{ protocol: 'invocations', version: '1.0.0' }],
    })
    .withHttpEndpoint({ name: 'http', env: 'PORT' })
    .withHttpHealthCheck({ path: '/readiness' })
    .withUrlForEndpoint('http', async (url) => {
        url.displayText = 'Meeting readiness hosted agent';
    })
    .withOtlpExporter({ protocol: OtlpProtocol.HttpProtobuf });

// planner is the background worker. It polls the broker API for queued intents
// and readiness jobs, then calls planner-agent only when a readiness job needs
// model-authored suggestions.
await builder
    .addNodeApp('planner', './services/planner', 'dist/worker.js')
    .withNpm({ install: false })
    // Run mode watches the worker source; deployment builds the dist entrypoint above.
    .withRunScript('dev:worker')
    .withBuildScript('build:worker')
    .withComputeEnvironment(aca)
    .withEnvironment('API_BASE_URL', api.getEndpoint('http'))
    .waitFor(api)
    // The worker invokes the Foundry-hosted agent through this AppHost-provided endpoint.
    .withEnvironment('PLANNER_AGENT_ENDPOINT', hostedAgent.getEndpoint('http'))
    .withReference(hostedAgent);

await builder
    .addViteApp('web', './apps/web')
    .withComputeEnvironment(aca)
    .withEnvironment('API_BASE_URL', api.getEndpoint('http'))
    .withReference(api)
    .waitFor(api)
    .withExternalHttpEndpoints()
    .withUrlForEndpoint('http', async (url) => {
        url.displayText = 'Calendar assistant';
    })
    .publishAsStaticWebsite({ apiPath: '/api', apiTarget: api })
    .withBrowserLogs();

await builder.build().run();