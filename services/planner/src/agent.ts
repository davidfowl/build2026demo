// Module: Foundry hosted-agent process entrypoint.
// Exports: nothing; export {} only marks the file as an ES module.
// Does: initializes telemetry/configuration and starts the hosted-agent HTTP
// server that receives Foundry invocations.
// Why: apphost.mts starts this file as planner-agent so readiness analysis can
// run inside the isolated hosted-agent resource.

export {};

process.env.OTEL_SERVICE_NAME ??= 'calendar-planner-agent';
await import('./otel');

const { serviceName, workerId } = await import('./config');
const { startHostedAgentServer } = await import('./hosted-agent-server');

console.log(`[planner-agent] ${workerId} service=${serviceName}`);

await startHostedAgentServer();
