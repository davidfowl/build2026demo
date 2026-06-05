import { z } from 'zod';
import {
  type HostedAgentContext,
  type MeetingReadinessJob,
  type ReadinessSuggestion,
  hostedAgentInvocationRequestSchema,
  hostedAgentInvocationResponseSchema,
} from './shared';
import {
  aiFoundryScope,
  delay,
  hostedAgentInvocationTimeoutMs,
  resolveHostedAgentEndpoint,
  withoutTrailingSlash,
} from './config';
import { modelReadinessSuggestionSchema, suggestionTitles } from './model-output';

// This is the worker-side client for the hosted agent. The endpoint is injected
// by apphost.mts as PLANNER_AGENT_ENDPOINT; this module only adds the Foundry
// invocations path, auth, retry, and session-affinity behavior.
const hostedAgentSessions = new Map<string, string>();
let cachedFoundryToken: { token: string; expiresOnTimestamp: number } | undefined;

export async function invokeHostedAgent(context: HostedAgentContext): Promise<ReadinessSuggestion[]> {
  const endpoint = resolveHostedAgentEndpoint();
  // Preserve Foundry session affinity for all jobs from the same browser session.
  const affinityKey = stableAgentSessionId(context.job);
  const body = JSON.stringify(hostedAgentInvocationRequestSchema.parse({ context, session_id: affinityKey }));

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const existingAgentSessionId = hostedAgentSessions.get(affinityKey);
    const invocationUrl = buildInvocationUrl(endpoint, existingAgentSessionId);
    const invocationHost = new URL(invocationUrl).host;
    const startedAt = Date.now();
    console.log(`[planner] invoking Foundry hosted agent job=${context.job.id} attempt=${attempt + 1} host=${invocationHost} browserSession=${context.job.sessionId} foundrySession=${existingAgentSessionId ? 'reused' : 'new'}.`);
    let response: Response;
    try {
      response = await fetch(invocationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...await hostedAgentAuthHeaders(invocationUrl),
        },
        body,
        signal: AbortSignal.timeout(hostedAgentInvocationTimeoutMs),
      });
    } catch (error) {
      if (attempt < 5 && isHostedAgentTimeout(error)) {
        hostedAgentSessions.delete(affinityKey);
        const retryDelayMs = 2000 * (attempt + 1);
        console.log(`[planner] Foundry hosted agent timed out for job=${context.job.id} after ${hostedAgentInvocationTimeoutMs}ms; retrying in ${retryDelayMs}ms.`);
        await delay(retryDelayMs);
        continue;
      }
      throw error;
    }
    const text = await response.text();
    const payload = parseJsonOrUndefined(text);
    console.log(`[planner] Foundry hosted agent response job=${context.job.id} attempt=${attempt + 1} status=${response.status} durationMs=${Date.now() - startedAt}.`);

    if (!response.ok) {
      if (attempt < 5 && isRetryableHostedAgentFailure(response.status, payload, text)) {
        hostedAgentSessions.delete(affinityKey);
        const retryDelayMs = 2000 * (attempt + 1);
        console.log(`[planner] Foundry hosted agent returned a retryable response for job=${context.job.id}; retrying in ${retryDelayMs}ms.`);
        await delay(retryDelayMs);
        continue;
      }

      throw new Error(`Hosted agent returned ${response.status}: ${text}`);
    }

    const returnedSessionId = extractHostedAgentSessionId(payload);
    if (returnedSessionId) {
      hostedAgentSessions.set(affinityKey, returnedSessionId);
    }

    const suggestions = extractHostedAgentSuggestions(payload);
    console.log(`[planner] Foundry hosted agent returned job=${context.job.id} foundrySession=${returnedSessionId ? 'present' : 'absent'} suggestions=${suggestions.length}: ${suggestionTitles(suggestions)}`);
    return suggestions;
  }

  throw new Error('Hosted agent invocation did not complete.');
}

function buildInvocationUrl(endpoint: string, agentSessionId: string | undefined): string {
  // Foundry exposes the hosted agent root; the invocations protocol lives under this fixed path.
  const base = withoutTrailingSlash(endpoint);
  const url = new URL(
    base.includes('/endpoint/protocols/invocations') ? base : `${base}/endpoint/protocols/invocations`,
  );
  url.searchParams.set('api-version', 'v1');
  if (agentSessionId) {
    url.searchParams.set('agent_session_id', agentSessionId);
  }
  return url.toString();
}

async function hostedAgentAuthHeaders(invocationUrl: string): Promise<Record<string, string>> {
  const url = new URL(invocationUrl);
  // Local AppHost runs call the local Node endpoint; deployed Foundry endpoints require Entra auth.
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    return {};
  }

  if (!cachedFoundryToken || Date.now() > cachedFoundryToken.expiresOnTimestamp - 5 * 60 * 1000) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const token = await new DefaultAzureCredential().getToken(aiFoundryScope);
    cachedFoundryToken = { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  }

  return {
    Authorization: `Bearer ${cachedFoundryToken.token}`,
    'Foundry-Features': 'HostedAgents=V1Preview',
  };
}

function extractHostedAgentSuggestions(payload: unknown): ReadinessSuggestion[] {
  const parsed = hostedAgentInvocationResponseSchema.safeParse(payload);
  if (parsed.success && parsed.data.suggestions) {
    return parsed.data.suggestions;
  }

  // Some hosted-agent responses put the assistant text in output.content instead
  // of duplicating structured data at the top level.
  const outputContent = z.object({
    output: z.object({
      content: z.string(),
    }),
  }).parse(payload).output.content;
  const contentPayload = JSON.parse(outputContent) as unknown;
  return z.object({ suggestions: z.array(modelReadinessSuggestionSchema) }).parse(contentPayload).suggestions;
}

function extractHostedAgentSessionId(payload: unknown): string | undefined {
  const parsed = hostedAgentInvocationResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.session_id : undefined;
}

function parseJsonOrUndefined(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRetryableHostedAgentFailure(status: number, payload: unknown, text: string): boolean {
  if (status === 424 || status >= 500) {
    return true;
  }

  const error = asRecord(asRecord(payload)?.error);
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message : text;
  return code === 'agent_version_not_ready'
    || code === 'server_error'
    || message.includes('still being provisioned')
    || message.includes('communicating with the session')
    || message.includes('Please retry');
}

function isHostedAgentTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stableAgentSessionId(job: MeetingReadinessJob): string {
  return `${job.userId}-${job.sessionId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
}
