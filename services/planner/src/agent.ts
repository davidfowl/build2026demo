// Entrypoint for the Foundry hosted-agent resource. apphost.mts runs this as
// planner-agent, which serves the invocations protocol and calls Copilot/Foundry.

export {};

process.env.OTEL_SERVICE_NAME ??= 'calendar-planner-agent';
await import('./otel');

const { serviceName, workerId } = await import('./config');
const { startHostedAgentServer } = await import('./hosted-agent-server');

console.log(`[planner-agent] ${workerId} service=${serviceName}`);

await startHostedAgentServer();
