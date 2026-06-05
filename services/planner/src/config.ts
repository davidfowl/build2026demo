import os from 'node:os';
import path from 'node:path';

// Runtime configuration comes from apphost.mts. Required service URLs should be
// injected there with withEnvironment/withReference instead of defaulting here.
export const serviceName = process.env.OTEL_SERVICE_NAME ?? 'calendar-planner-worker';
export const workerId = `${serviceName}-${process.pid}`;

// Timing knobs are optional runtime tuning values, not service discovery.
export const pollMs = numberEnv('PLANNER_POLL_MS', 5000);
export const toolDelayMs = numberEnv('READINESS_TOOL_DELAY_MS', 750);
export const copilotOtelFlushDelayMs = numberEnv('COPILOT_OTEL_FLUSH_DELAY_MS', 1500);
export const copilotTimeoutMs = numberEnv('COPILOT_TIMEOUT_MS', 120000);
export const hostedAgentInvocationTimeoutMs = numberEnv('HOSTED_AGENT_INVOCATION_TIMEOUT_MS', 90000);

// The Copilot SDK wants a writable home/work directory even inside the hosted
// agent sandbox. These are local filesystem paths, so safe defaults are fine.
export const copilotWorkingDirectory = process.env.COPILOT_WORKING_DIRECTORY ?? os.tmpdir();
export const copilotHome = process.env.COPILOT_HOME ?? path.join(copilotWorkingDirectory, '.copilot-hosted-agent');

// Azure AI Foundry uses this resource scope for both hosted-agent invocation
// auth and model-provider auth.
export const aiFoundryScope = 'https://ai.azure.com/.default';

export function resolveHostedAgentEndpoint(): string {
  // apphost.mts sets this from hostedAgent.getEndpoint('http') on the worker.
  return requiredEnv('PLANNER_AGENT_ENDPOINT');
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

export function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number.`);
  }
  return value;
}
