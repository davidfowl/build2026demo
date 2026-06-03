import {
    FoundryModels,
    HttpCommandResultMode,
    InputType,
    createBuilder,
    type ExecuteCommandContext,
    type ExecuteCommandResult,
} from './.aspire/modules/aspire.mjs';

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
    .withEnvironment('OTEL_SERVICE_NAME', 'calendar-broker-api')
    .withReference(calendarDb)
    .waitFor(calendarDb)
    .withHttpEndpoint({ name: 'http', env: 'PORT' })
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

let planner = builder
    .addNodeApp('planner', './services/planner', 'src/worker.ts')
    .withRunScript('dev')
    .withEnvironment('API_BASE_URL', api.getEndpoint('http'))
    .withEnvironment('PLANNER_MODE', plannerMode)
    .withEnvironment('OTEL_SERVICE_NAME', 'calendar-planner-worker')
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
    .withUrlForEndpoint('http', async (url) => {
        url.displayText = 'Calendar assistant';
    })
    .publishAsStaticWebsite({ apiPath: '/api', apiTarget: api })
    .withBrowserLogs();

await builder.build().run();