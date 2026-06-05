// Entrypoint for the planner worker resource. apphost.mts runs this as planner,
// which polls the broker API, creates CalendarPatch proposals, invokes the
// hosted agent for readiness jobs, and writes validated results back to the API.

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
