// Module: planner worker process entrypoint.
// Exports: nothing; export {} only marks the file as an ES module.
// Does: initializes telemetry/configuration, then runs the planning and
// readiness polling loops in parallel.
// Why: apphost.mts starts this file as the planner resource that turns broker
// queue items into CalendarPatch proposals and readiness results.

export {};

process.env.OTEL_SERVICE_NAME ??= 'calendar-planner-worker';
await import('./otel');

const { configuredApiBaseUrl } = await import('./api-client');
const { serviceName, workerId } = await import('./config');
const { runPlanningLoop } = await import('./planning-worker');
const { runReadinessLoop } = await import('./readiness-worker');

console.log(`[planner] ${workerId} service=${serviceName} api=${configuredApiBaseUrl()}`);
console.log('[planner] Planner is not a calendar write authority; it emits CalendarPatch[] proposals and readiness suggestions.');

await Promise.all([runPlanningLoop(), runReadinessLoop()]);
