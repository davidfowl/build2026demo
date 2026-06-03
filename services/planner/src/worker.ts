import './otel';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { CopilotSession, ProviderConfig } from '@github/copilot-sdk';
import { z } from 'zod';
import {
  type AppState,
  type CalendarEvent,
  type CalendarPatch,
  type HostedAgentContext,
  type MeetingReadinessJob,
  type PatchProposal,
  type PlanningIntent,
  type ReadinessSuggestion,
  appStateSchema,
  calendarEventSchema,
  hostedAgentContextSchema,
  hostedAgentInvocationRequestSchema,
  hostedAgentInvocationResponseSchema,
  id,
  intentSchema,
  meetingReadinessJobSchema,
  minutesBetween,
  moveWindow,
  readinessSuggestionSchema,
} from './shared';

const apiBaseUrl = withoutTrailingSlash(process.env.API_BASE_URL ?? 'http://localhost:4310');
type PlannerMode = 'local' | 'foundry-hosted' | 'copilot-sdk';

const plannerMode: PlannerMode = process.env.PLANNER_MODE === 'foundry-hosted'
  ? 'foundry-hosted'
  : process.env.PLANNER_MODE === 'copilot-sdk'
    ? 'copilot-sdk'
    : 'local';
const plannerRole = process.env.PLANNER_ROLE === 'agent' ? 'agent' : 'worker';
const workerId = `${plannerMode}-planner-${process.pid}`;
const pollMs = Number(process.env.PLANNER_POLL_MS ?? 2000);
const toolDelayMs = Number(process.env.READINESS_TOOL_DELAY_MS ?? 750);
const hostedAgentSessions = new Map<string, string>();
const copilotHome = path.join(os.tmpdir(), '.build2026-copilot-sdk-planner');
const copilotSessions = new Map<string, CopilotSession>();
const copilotSessionLocks = new Map<string, Promise<void>>();
let cachedFoundryToken: { token: string; expiresOnTimestamp: number } | undefined;
let copilotClient: { start(): Promise<void>; createSession(options: unknown): Promise<CopilotSession>; resumeSession(sessionId: string, options: unknown): Promise<CopilotSession> } | undefined;
let cachedProviderConfig: ProviderConfig | undefined;
let providerTokenExpiresOn = 0;

const calendarWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
  events: z.array(calendarEventSchema),
});
type CalendarWindow = z.infer<typeof calendarWindowSchema>;

const weatherSchema = z.object({
  location: z.string(),
  forecastAt: z.string(),
  condition: z.string(),
  temperatureF: z.number(),
  precipitationChance: z.number(),
  recommendation: z.string(),
});
type WeatherReport = z.infer<typeof weatherSchema>;

const travelSchema = z.object({
  from: z.string(),
  to: z.string(),
  previousEvent: z.object({ id: z.string(), title: z.string(), end: z.string() }).nullable(),
  travelMinutes: z.number(),
  leaveAt: z.string(),
  recommendation: z.string(),
});
type TravelPlan = z.infer<typeof travelSchema>;

const materialsSchema = z.object({
  topic: z.string(),
  agendaStatus: z.string(),
  checklist: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
type MeetingMaterials = z.infer<typeof materialsSchema>;

console.log(`[planner] ${workerId} role=${plannerRole} mode=${plannerMode} using ${apiBaseUrl}`);
console.log('[planner] Planner is not a calendar write authority; it emits CalendarPatch[] proposals and readiness suggestions.');
if (plannerMode === 'copilot-sdk') {
  logCopilotEnvironment();
}

if (plannerRole === 'agent') {
  await startHostedAgentServer();
} else {
  await Promise.all([runPlanningLoop(), runReadinessLoop()]);
}

async function runPlanningLoop(): Promise<void> {
  for (;;) {
    try {
      await processOneIntent();
    } catch (error) {
      console.error('[planner] planning loop error', error);
    }
    await delay(pollMs);
  }
}

async function runReadinessLoop(): Promise<void> {
  for (;;) {
    try {
      await processOneReadinessJob();
    } catch (error) {
      console.error('[planner] readiness loop error', error);
    }
    await delay(pollMs);
  }
}

async function startHostedAgentServer(): Promise<never> {
  const port = Number(process.env.PORT ?? process.env.DEFAULT_AD_PORT ?? 8088);

  createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && ['/health', '/readiness', '/liveness'].includes(request.url ?? '')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ready', workerId, mode: plannerMode }));
        return;
      }

      if (request.method === 'POST' && request.url?.includes('/invocations')) {
        const body = hostedAgentInvocationRequestSchema.parse(await readJsonBody(request));
        const context = extractHostedAgentContext(body);
        const sessionId = getHostedAgentSessionId(request.url, body);
        console.log(`[planner-agent] invocation received job=${context.job.id} meeting=${context.meeting.id} session=${sessionId}.`);
        const suggestions = createReadinessSuggestions(
          context.job,
          context.meeting,
          context.calendarWindow,
          context.weather,
          context.travel,
          context.materials,
        );
        const content = JSON.stringify({ suggestions });
        console.log(`[planner-agent] invocation completed job=${context.job.id} suggestions=${suggestions.length}: ${suggestionTitles(suggestions)}`);

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          invocation_id: randomUUID(),
          session_id: sessionId,
          output: { role: 'assistant', content },
          suggestions,
        }));
        return;
      }

      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      console.error('[planner-agent] invocation failed', error);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid hosted-agent request.' }));
    }
  }).listen(port, () => {
    console.log(`[planner-agent] invocations endpoint listening on http://localhost:${port}/invocations`);
  });

  return new Promise<never>(() => undefined);
}

async function processOneIntent(): Promise<void> {
  const claimedResponse = await fetch(`${apiBaseUrl}/api/planner/next-intent?workerId=${encodeURIComponent(workerId)}`);
  if (claimedResponse.status === 204) {
    return;
  }
  if (!claimedResponse.ok) {
    throw new Error(`Claim failed: ${claimedResponse.status} ${await claimedResponse.text()}`);
  }

  const claimed = await claimedResponse.json() as unknown;
  const intent = intentSchema.parse((claimed as { intent: unknown }).intent);
  const event = calendarEventSchema.parse((claimed as { event: unknown }).event);
  const state = await fetchState();
  const proposal = createProposal(intent, event, state);

  const submitResponse = await fetch(`${apiBaseUrl}/api/planner/proposals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal }),
  });

  if (!submitResponse.ok) {
    throw new Error(`Proposal failed: ${submitResponse.status} ${await submitResponse.text()}`);
  }

  const result = await submitResponse.json() as { decisions?: unknown[] };
  console.log(`[planner] submitted ${proposal.patches.length} patch(es) for ${intent.id}; broker returned ${result.decisions?.length ?? 0} decision(s)`);
}

async function fetchState(): Promise<AppState> {
  const response = await fetch(`${apiBaseUrl}/api/state`);
  if (!response.ok) {
    throw new Error(`State fetch failed: ${response.status} ${await response.text()}`);
  }
  return appStateSchema.parse(await response.json());
}

async function processOneReadinessJob(): Promise<void> {
  const claimedResponse = await fetch(`${apiBaseUrl}/api/planner/next-readiness-job?workerId=${encodeURIComponent(workerId)}`);
  if (claimedResponse.status === 204) {
    return;
  }
  if (!claimedResponse.ok) {
    throw new Error(`Readiness claim failed: ${claimedResponse.status} ${await claimedResponse.text()}`);
  }

  const claimed = await claimedResponse.json() as unknown;
  const job = meetingReadinessJobSchema.parse((claimed as { job: unknown }).job);
  console.log(`[planner] claimed readiness job ${job.id} meeting=${job.meetingId} session=${job.sessionId}.`);

  try {
    await runReadinessAnalysis(job);
  } catch (error) {
    await failReadinessJob(job.id, error instanceof Error ? error.message : 'Unknown readiness agent failure.');
    throw error;
  }
}

async function runReadinessAnalysis(job: MeetingReadinessJob): Promise<void> {
  console.log(`[planner] starting readiness analysis job=${job.id} meeting=${job.meetingId} mode=${plannerMode}.`);
  const context = await loadReadinessContext(job);
  if (!context) {
    console.log(`[planner] readiness job ${job.id} stopped before context load completed.`);
    return;
  }
  console.log(`[planner] loaded readiness context job=${job.id} meeting="${context.meeting.title}" calendarEvents=${context.calendarWindow.events.length} weather="${context.weather.condition}" travelMinutes=${context.travel.travelMinutes}.`);

  let suggestions: ReadinessSuggestion[];
  if (plannerMode === 'foundry-hosted') {
    if (!(await recordProgress(job.id, 'hosted-agent', 'Invoking Foundry hosted agent', 'Sent the scoped meeting context to the isolated hosted-agent session.'))) {
      return;
    }
    suggestions = await invokeHostedAgent(context);
    if (!(await recordProgress(job.id, 'agent-result', 'Received hosted-agent result', `Validated ${suggestions.length} readiness suggestion(s) from the hosted agent.`))) {
      return;
    }
  } else if (plannerMode === 'copilot-sdk') {
    if (!(await recordProgress(job.id, 'copilot-sdk', 'Invoking Copilot SDK', 'Sent the scoped meeting context to the Copilot SDK with the Foundry model provider.'))) {
      return;
    }
    suggestions = await invokeCopilotSdk(context);
    if (!(await recordProgress(job.id, 'agent-result', 'Received Copilot SDK result', `Validated ${suggestions.length} readiness suggestion(s) from model inference.`))) {
      return;
    }
  } else {
    if (!(await recordProgress(job.id, 'scoring', 'Scoring readiness suggestions', 'Ranked prep time, weather, travel, and agenda/materials recommendations.'))) {
      return;
    }
    if (!(await continueAfterDelay(job.id))) {
      return;
    }
    suggestions = createReadinessSuggestions(
      context.job,
      context.meeting,
      context.calendarWindow,
      context.weather,
      context.travel,
      context.materials,
    );
  }

  await postJson(`/api/planner/readiness-jobs/${encodeURIComponent(job.id)}/result`, { suggestions });
  console.log(`[planner] completed readiness job ${job.id} with ${suggestions.length} suggestion(s): ${suggestionTitles(suggestions)}`);
}

async function loadReadinessContext(job: MeetingReadinessJob): Promise<HostedAgentContext | undefined> {
  if (!(await recordProgress(job.id, 'meeting', 'Reading meeting details', 'Loaded title, attendees, location, and agenda notes.'))) {
    return undefined;
  }
  if (!(await continueAfterDelay(job.id))) {
    return undefined;
  }
  const meeting = calendarEventSchema.parse(await fetchJson(`/api/agent/meetings/${encodeURIComponent(job.meetingId)}`));

  if (!(await recordProgress(job.id, 'calendar-window', 'Scanning the 7-day calendar', 'Looked for open focus windows and risky adjacent meetings.'))) {
    return undefined;
  }
  if (!(await continueAfterDelay(job.id))) {
    return undefined;
  }
  const calendarWindow = calendarWindowSchema.parse(await fetchJson(`/api/agent/calendar-window?meetingId=${encodeURIComponent(job.meetingId)}&days=7`));

  if (!(await recordProgress(job.id, 'weather', 'Checking meeting-day weather', 'Pulled location-specific weather so the advice is useful on the day.'))) {
    return undefined;
  }
  if (!(await continueAfterDelay(job.id))) {
    return undefined;
  }
  const weather = weatherSchema.parse(await fetchJson(`/api/agent/weather?meetingId=${encodeURIComponent(job.meetingId)}`));

  if (!(await recordProgress(job.id, 'travel', 'Estimating travel and setup buffer', 'Compared the previous event with the meeting location.'))) {
    return undefined;
  }
  if (!(await continueAfterDelay(job.id))) {
    return undefined;
  }
  const travel = travelSchema.parse(await fetchJson(`/api/agent/travel?meetingId=${encodeURIComponent(job.meetingId)}`));

  if (!(await recordProgress(job.id, 'materials', 'Reviewing agenda and materials', 'Checked the meeting notes for a checklist and open questions.'))) {
    return undefined;
  }
  if (!(await continueAfterDelay(job.id))) {
    return undefined;
  }
  const materials = materialsSchema.parse(await fetchJson(`/api/agent/materials?meetingId=${encodeURIComponent(job.meetingId)}`));

  return hostedAgentContextSchema.parse({ job, meeting, calendarWindow, weather, travel, materials });
}

async function recordProgress(jobId: string, stepId: string, label: string, detail: string): Promise<boolean> {
  const result = await postJson(`/api/planner/readiness-jobs/${encodeURIComponent(jobId)}/progress`, { stepId, label, detail }) as { job?: unknown };
  const current = meetingReadinessJobSchema.parse(result.job);
  return current.status === 'running';
}

async function continueAfterDelay(jobId: string): Promise<boolean> {
  await delay(toolDelayMs);
  const state = await fetchState();
  return state.readinessJobs.find((job) => job.id === jobId)?.status === 'running';
}

async function failReadinessJob(jobId: string, error: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/planner/readiness-jobs/${encodeURIComponent(jobId)}/fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error }),
  });
  if (!response.ok) {
    console.error(`[planner] failed to mark readiness job ${jobId} failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function invokeHostedAgent(context: HostedAgentContext): Promise<ReadinessSuggestion[]> {
  const endpoint = resolveHostedAgentEndpoint();
  const affinityKey = stableAgentSessionId(context.job);
  const existingAgentSessionId = hostedAgentSessions.get(affinityKey);
  const invocationUrl = buildInvocationUrl(endpoint, existingAgentSessionId);
  const invocationHost = new URL(invocationUrl).host;
  const body = JSON.stringify({ context, session_id: affinityKey });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const startedAt = Date.now();
    console.log(`[planner] invoking Foundry hosted agent job=${context.job.id} attempt=${attempt + 1} host=${invocationHost} browserSession=${context.job.sessionId} foundrySession=${existingAgentSessionId ? 'reused' : 'new'}.`);
    const response = await fetch(invocationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...await hostedAgentAuthHeaders(invocationUrl),
      },
      body,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : undefined;
    console.log(`[planner] Foundry hosted agent response job=${context.job.id} attempt=${attempt + 1} status=${response.status} durationMs=${Date.now() - startedAt}.`);

    if (response.status === 424 && attempt < 3) {
      console.log(`[planner] Foundry hosted agent not ready for job=${context.job.id}; retrying.`);
      await delay(2000);
      continue;
    }

    if (!response.ok) {
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

async function invokeCopilotSdk(context: HostedAgentContext): Promise<ReadinessSuggestion[]> {
  const sessionId = stableAgentSessionId(context.job);
  return withCopilotSessionLock(sessionId, async () => {
    const startedAt = Date.now();
    try {
      const session = await getCopilotSession(sessionId);
      const prompt = buildCopilotReadinessPrompt(context);
      console.log(`[planner] Copilot SDK send start job=${context.job.id} session=${sessionId} promptBytes=${Buffer.byteLength(prompt, 'utf8')}.`);
      const response = await session.sendAndWait({ prompt }, 90_000);
      const content = response?.data?.content;
      console.log(`[planner] Copilot SDK send completed job=${context.job.id} durationMs=${Date.now() - startedAt} contentBytes=${typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0}.`);
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('Copilot SDK completed without an assistant text response.');
      }

      const suggestions = parseCopilotSuggestions(content);
      console.log(`[planner] Copilot SDK returned job=${context.job.id} suggestions=${suggestions.length}: ${suggestionTitles(suggestions)}`);
      return suggestions;
    } catch (error) {
      console.error(`[planner] Copilot SDK inference failed job=${context.job.id} durationMs=${Date.now() - startedAt}:`, error);
      throw error;
    }
  });
}

async function getCopilotSession(sessionId: string): Promise<CopilotSession> {
  const cached = copilotSessions.get(sessionId);
  if (cached && cachedProviderConfig && Date.now() < providerTokenExpiresOn - 5 * 60 * 1000) {
    return cached;
  }

  const copilot = await ensureCopilotClient();
  const provider = await ensureProviderConfig();
  const config = {
    model: copilotModelId(),
    provider,
    availableTools: [],
    onPermissionRequest: (await import('@github/copilot-sdk')).approveAll,
    systemMessage: {
      mode: 'append',
      content: [
        'You are the meeting readiness agent for an Aspire Build 2026 demo.',
        'Return only JSON. Do not include markdown fences or prose.',
        'The calendar broker is the only write authority. You may propose CalendarPatch objects, but never claim that you applied changes.',
      ].join('\n'),
    },
  };

  try {
    console.log(`[planner] Copilot SDK resuming session ${sessionId}.`);
    const resumed = await copilot.resumeSession(sessionId, config);
    copilotSessions.set(sessionId, resumed);
    console.log(`[planner] Copilot SDK resumed session ${sessionId}.`);
    return resumed;
  } catch (error) {
    console.log(`[planner] Copilot SDK creating session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    const created = await copilot.createSession({ ...config, sessionId });
    copilotSessions.set(sessionId, created);
    console.log(`[planner] Copilot SDK created session ${sessionId}.`);
    return created;
  }
}

async function ensureCopilotClient(): Promise<NonNullable<typeof copilotClient>> {
  if (copilotClient) {
    return copilotClient;
  }

  const { CopilotClient } = await import('@github/copilot-sdk');
  console.log(`[planner] Starting Copilot SDK client home=${copilotHome}.`);
  copilotClient = new CopilotClient({
    mode: 'empty',
    useLoggedInUser: false,
    baseDirectory: copilotHome,
    workingDirectory: os.tmpdir(),
    logLevel: copilotLogLevel(),
  });
  await copilotClient.start();
  console.log('[planner] Copilot SDK client started.');
  return copilotClient;
}

async function ensureProviderConfig(): Promise<ProviderConfig> {
  if (cachedProviderConfig && Date.now() < providerTokenExpiresOn - 5 * 60 * 1000) {
    return cachedProviderConfig;
  }

  const { DefaultAzureCredential } = await import('@azure/identity');
  console.log('[planner] Acquiring Azure AI Foundry token for Copilot SDK provider.');
  const token = await new DefaultAzureCredential().getToken('https://ai.azure.com/.default');
  providerTokenExpiresOn = token.expiresOnTimestamp;
  cachedProviderConfig = {
    type: 'openai',
    wireApi: 'completions',
    baseUrl: deriveFoundryProjectEndpoint(),
    bearerToken: token.token,
    modelId: copilotModelId(),
    wireModel: foundryDeploymentName(),
  };
  copilotSessions.clear();
  console.log(`[planner] Configured Copilot SDK Foundry provider baseUrl=${cachedProviderConfig.baseUrl} model=${copilotModelId()} deployment=${foundryDeploymentName()} tokenExpires=${new Date(providerTokenExpiresOn).toISOString()}.`);
  return cachedProviderConfig;
}

function buildCopilotReadinessPrompt(context: HostedAgentContext): string {
  return JSON.stringify({
    task: 'Analyze meeting readiness and return JSON shaped exactly as { "suggestions": ReadinessSuggestion[] }.',
    rules: [
      'Return 2-4 suggestions.',
      'Valid suggestion kind values are prep-time, weather-attire, travel-buffer, agenda-materials.',
      'Use proposedPatch only for user-visible calendar changes.',
      'Every proposedPatch must include operation=create, intentId, changes, reason, and confidence between 0 and 1.',
      'Use the provided ids. suggestion.id and patch.id must be non-empty strings.',
      'Do not include markdown, comments, or extra text outside the JSON object.',
    ],
    ids: {
      jobId: context.job.id,
      prepSuggestionId: id('suggestion'),
      prepPatchId: id('patch'),
      travelSuggestionId: id('suggestion'),
      travelPatchId: id('patch'),
      weatherSuggestionId: id('suggestion'),
      materialsSuggestionId: id('suggestion'),
    },
    context,
    example: {
      suggestions: createReadinessSuggestions(
        context.job,
        context.meeting,
        context.calendarWindow,
        context.weather,
        context.travel,
        context.materials,
      ),
    },
  });
}

function parseCopilotSuggestions(content: string): ReadinessSuggestion[] {
  const json = extractJsonObject(content);
  try {
    const payload = JSON.parse(json) as unknown;
    return z.object({ suggestions: z.array(readinessSuggestionSchema).min(1) }).parse(payload).suggestions;
  } catch (error) {
    console.error(`[planner] Failed to parse Copilot SDK JSON. rawPreview=${previewForLog(content)} jsonPreview=${previewForLog(json)}`);
    throw error;
  }
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function parseConnectionString(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value) {
    return result;
  }

  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      result[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
    }
  }
  return result;
}

function deriveFoundryProjectEndpoint(): string {
  const explicit = process.env.FOUNDRY_PROJECT_ENDPOINT ?? process.env.COPILOT_PROVIDER_BASE_URL;
  if (explicit) {
    return normalizeFoundryEndpoint(explicit);
  }

  const connection = parseConnectionString(process.env.ConnectionStrings__chat);
  const serviceEndpoint = process.env.CHAT_URI
    ?? process.env.CHAT_AIINFERENCEURI
    ?? connection.endpointaiinference;
  if (!serviceEndpoint) {
    throw new Error('PLANNER_MODE=copilot-sdk requires a Foundry model reference. Expected FOUNDRY_PROJECT_ENDPOINT or CHAT_URI/CHAT_AIINFERENCEURI from withReference(chat).');
  }

  const normalized = normalizeFoundryEndpoint(serviceEndpoint);
  if (normalized.includes('/api/projects/')) {
    return normalized;
  }

  const base = normalized.replace(/\/models$/i, '');
  const projectName = process.env.FOUNDRY_PROJECT_NAME ?? 'calendarplanning';
  return `${base}/api/projects/${encodeURIComponent(projectName)}/openai/v1`;
}

function normalizeFoundryEndpoint(endpoint: string): string {
  const base = withoutTrailingSlash(endpoint);
  if (base.includes('/api/projects/') && !base.endsWith('/openai/v1')) {
    return `${base}/openai/v1`;
  }
  return base;
}

function foundryDeploymentName(): string {
  const connection = parseConnectionString(process.env.ConnectionStrings__chat);
  return process.env.CHAT_MODELNAME ?? connection.deployment ?? 'chat';
}

function copilotModelId(): string {
  return process.env.COPILOT_MODEL_ID ?? foundryDeploymentName();
}

function copilotLogLevel(): 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all' {
  const value = process.env.COPILOT_LOG_LEVEL;
  return value === 'none' || value === 'error' || value === 'warning' || value === 'info' || value === 'debug' || value === 'all'
    ? value
    : 'info';
}

function logCopilotEnvironment(): void {
  const connection = parseConnectionString(process.env.ConnectionStrings__chat);
  const keys = Object.keys(connection).sort();
  console.log(`[planner] Copilot SDK env: CHAT_URI=${present(process.env.CHAT_URI)} CHAT_AIINFERENCEURI=${present(process.env.CHAT_AIINFERENCEURI)} CHAT_MODELNAME=${process.env.CHAT_MODELNAME ?? '<unset>'} ConnectionStrings__chat=${present(process.env.ConnectionStrings__chat)} connectionKeys=${keys.join(',') || '<none>'} FOUNDRY_PROJECT_NAME=${process.env.FOUNDRY_PROJECT_NAME ?? '<unset>'} COPILOT_MODEL_ID=${process.env.COPILOT_MODEL_ID ?? '<unset>'}.`);
}

function present(value: string | undefined): 'set' | 'unset' {
  return value ? 'set' : 'unset';
}

function previewForLog(value: string): string {
  return JSON.stringify(value.slice(0, 800));
}

async function withCopilotSessionLock<T>(sessionId: string, callback: () => Promise<T>): Promise<T> {
  const prior = copilotSessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => current);
  copilotSessionLocks.set(sessionId, tail);
  await prior;
  try {
    return await callback();
  } finally {
    release();
    if (copilotSessionLocks.get(sessionId) === tail) {
      copilotSessionLocks.delete(sessionId);
    }
  }
}

function suggestionTitles(suggestions: ReadinessSuggestion[]): string {
  return suggestions.map((suggestion) => `"${suggestion.title}"`).join(', ');
}

function resolveHostedAgentEndpoint(): string {
  const explicit = firstEnv(
    'PLANNER_AGENT_ENDPOINT',
    'services__planner-agent__http__0',
    'services__planner_agent__http__0',
    'PLANNER_AGENT_HTTP',
    'PLANNER_AGENT_HTTPS',
    'FOUNDRY_AGENT_ENDPOINT',
  );
  if (explicit) {
    return explicit;
  }

  const serviceDiscoveryEndpoint = Object.entries(process.env)
    .filter(([key, value]) => value && key.toLowerCase().includes('planner') && key.toLowerCase().includes('agent'))
    .map(([, value]) => value)
    .find((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value));
  if (serviceDiscoveryEndpoint) {
    return serviceDiscoveryEndpoint;
  }

  throw new Error('PLANNER_MODE=foundry-hosted requires PLANNER_AGENT_ENDPOINT or a planner-agent service reference.');
}

function buildInvocationUrl(endpoint: string, agentSessionId: string | undefined): string {
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
  if (process.env.FOUNDRY_AUTH_DISABLED === 'true' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    return {};
  }

  if (!cachedFoundryToken || Date.now() > cachedFoundryToken.expiresOnTimestamp - 5 * 60 * 1000) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const token = await new DefaultAzureCredential().getToken('https://ai.azure.com/.default');
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

  const outputContent = z.object({
    output: z.object({
      content: z.string(),
    }),
  }).parse(payload).output.content;
  const contentPayload = JSON.parse(outputContent) as unknown;
  return z.object({ suggestions: z.array(readinessSuggestionSchema) }).parse(contentPayload).suggestions;
}

function extractHostedAgentSessionId(payload: unknown): string | undefined {
  const parsed = hostedAgentInvocationResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.session_id : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as unknown;
}

function extractHostedAgentContext(body: z.infer<typeof hostedAgentInvocationRequestSchema>): HostedAgentContext {
  if (body.context) {
    return body.context;
  }

  if (body.input && typeof body.input === 'object') {
    return hostedAgentContextSchema.parse(body.input);
  }

  if (typeof body.input === 'string') {
    return hostedAgentContextSchema.parse(JSON.parse(body.input));
  }

  if (body.message) {
    return hostedAgentContextSchema.parse(JSON.parse(body.message));
  }

  throw new Error('Hosted-agent invocation requires context, object input, JSON string input, or JSON message.');
}

function getHostedAgentSessionId(url: string, body: z.infer<typeof hostedAgentInvocationRequestSchema>): string {
  const requested = new URL(url, 'http://localhost').searchParams.get('agent_session_id');
  const requestSessionId = 'session_id' in body && typeof body.session_id === 'string' ? body.session_id : undefined;
  return process.env.FOUNDRY_AGENT_SESSION_ID ?? requested ?? requestSessionId ?? 'local-agent-session';
}

function stableAgentSessionId(job: MeetingReadinessJob): string {
  return `${job.userId}-${job.sessionId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function createProposal(intent: PlanningIntent, event: CalendarEvent, state: AppState): PatchProposal {
  const window = moveWindow(event, intent.desiredStart, intent.desiredEnd);
  const patches: CalendarPatch[] = [
    {
      id: id('patch'),
      intentId: intent.id,
      operation: 'move',
      eventId: event.id,
      baseEtag: intent.etagAtIntent,
      changes: window,
      reason: `Move "${event.title}" to satisfy the user's direct planning intent.`,
      confidence: event.kind === 'meeting' ? 0.72 : 0.91,
    },
  ];

  const overlapped = findFlexibleOverlap(event, window.start, window.end, state.events);
  if (overlapped) {
    const duration = minutesBetween(overlapped.start, overlapped.end);
    const nextStart = new Date(window.end);
    nextStart.setMinutes(nextStart.getMinutes() + 15);
    const nextEnd = new Date(nextStart);
    nextEnd.setMinutes(nextEnd.getMinutes() + duration);

    patches.push({
      id: id('patch'),
      intentId: intent.id,
      operation: 'move',
      eventId: overlapped.id,
      baseEtag: overlapped.etag,
      changes: {
        start: nextStart.toISOString(),
        end: nextEnd.toISOString(),
      },
      reason: `Move "${overlapped.title}" because it conflicts with the dragged block.`,
      confidence: 0.83,
    });
  }

  return {
    id: id('proposal'),
    intentId: intent.id,
    createdAt: new Date().toISOString(),
    createdBy: plannerMode === 'foundry-hosted'
      ? 'foundry-hosted-agent'
      : plannerMode === 'copilot-sdk'
        ? 'copilot-sdk-planner'
        : 'local-planner-worker',
    plannerMode,
    patches,
    hostedAgentSession: plannerMode === 'foundry-hosted' ? hostedAgentSession(intent, event, patches) : undefined,
  };
}

function findFlexibleOverlap(source: CalendarEvent, start: string, end: string, events: CalendarEvent[]): CalendarEvent | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return events.find((event) => {
    if (event.id === source.id) {
      return false;
    }
    if (!['draft', 'focus', 'task'].includes(event.kind)) {
      return false;
    }
    const eventStart = Date.parse(event.start);
    const eventEnd = Date.parse(event.end);
    return startMs < eventEnd && endMs > eventStart;
  });
}

function createReadinessSuggestions(
  job: MeetingReadinessJob,
  meeting: CalendarEvent,
  calendarWindow: CalendarWindow,
  weather: WeatherReport,
  travel: TravelPlan,
  materials: MeetingMaterials,
): ReadinessSuggestion[] {
  const prepMinutes = 45;
  const prepSlot = findPrepSlot(calendarWindow, meeting, prepMinutes);
  const travelStart = travel.leaveAt;

  return [
    {
      id: id('suggestion'),
      kind: 'prep-time',
      title: `Book ${prepMinutes} minutes of prep`,
      detail: `${formatRange(prepSlot.start, prepSlot.end)} gives you focused time before "${meeting.title}".`,
      rationale: prepSlot.reason,
      proposedPatch: {
        id: id('patch'),
        intentId: job.id,
        operation: 'create',
        changes: {
          title: `Prep: ${meeting.title}`,
          kind: 'prep',
          calendarId: meeting.calendarId,
          start: prepSlot.start,
          end: prepSlot.end,
          description: `Readiness agent prep block. Review: ${materials.checklist.slice(0, 2).join('; ')}.`,
        },
        reason: `Create a prep block before "${meeting.title}" after scanning the 7-day calendar.`,
        confidence: 0.9,
      },
    },
    {
      id: id('suggestion'),
      kind: 'weather-attire',
      title: 'Plan for wet weather',
      detail: `${weather.condition}, ${weather.temperatureF}F, ${weather.precipitationChance}% chance of rain near ${weather.location}.`,
      rationale: weather.recommendation,
    },
    {
      id: id('suggestion'),
      kind: 'travel-buffer',
      title: `Hold ${travel.travelMinutes} minutes for travel/setup`,
      detail: travel.recommendation,
      rationale: travel.previousEvent
        ? `Previous event ends at ${formatClock(travel.previousEvent.end)}; leave by ${formatClock(travel.leaveAt)}.`
        : `No adjacent event was found, but the location still needs setup time.`,
      proposedPatch: {
        id: id('patch'),
        intentId: job.id,
        operation: 'create',
        changes: {
          title: `Travel/setup: ${meeting.title}`,
          kind: 'prep',
          calendarId: meeting.calendarId,
          start: travelStart,
          end: meeting.start,
          description: `Readiness agent travel/setup buffer from ${travel.from} to ${travel.to}.`,
        },
        reason: `Create a travel/setup buffer before "${meeting.title}".`,
        confidence: 0.82,
      },
    },
    {
      id: id('suggestion'),
      kind: 'agenda-materials',
      title: materials.agendaStatus === 'agenda-present' ? 'Bring the demo checklist' : 'Ask for an agenda',
      detail: materials.checklist.join(' | '),
      rationale: `Open questions: ${materials.openQuestions.join(' ')}`,
    },
  ];
}

function findPrepSlot(calendarWindow: CalendarWindow, meeting: CalendarEvent, minutes: number): { start: string; end: string; reason: string } {
  const meetingStartMs = Date.parse(meeting.start);
  const windowStartDay = startOfDay(new Date(calendarWindow.start));
  const firstPrepDay = startOfDay(addDays(new Date(meeting.start), -1));
  const candidateTimes: Array<[number, number]> = [[10, 0], [9, 0], [13, 0], [15, 0]];

  for (let day = firstPrepDay; day.getTime() >= windowStartDay.getTime(); day = addDays(day, -1)) {
    for (const [hour, minute] of candidateTimes) {
      const start = new Date(day);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + minutes * 60000);
      if (end.getTime() > meetingStartMs - 60 * 60000) {
        continue;
      }
      if (isFree(calendarWindow.events, start.toISOString(), end.toISOString())) {
        return {
          start: start.toISOString(),
          end: end.toISOString(),
          reason: `Found an open ${minutes}-minute focus window in the 7-day calendar before the meeting.`,
        };
      }
    }
  }

  const fallbackEnd = new Date(meetingStartMs - 90 * 60000);
  const fallbackStart = new Date(fallbackEnd.getTime() - minutes * 60000);
  return {
    start: fallbackStart.toISOString(),
    end: fallbackEnd.toISOString(),
    reason: 'No perfect opening was found, so the agent picked the least risky gap before the meeting.',
  };
}

function isFree(events: CalendarEvent[], start: string, end: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return !events.some((event) => startMs < Date.parse(event.end) && endMs > Date.parse(event.start));
}

function startOfDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value: Date, days: number): Date {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function formatRange(start: string, end: string): string {
  return `${formatClock(start)}-${formatClock(end)}`;
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function hostedAgentSession(intent: PlanningIntent, event: CalendarEvent, patches: CalendarPatch[]): PatchProposal['hostedAgentSession'] {
  return {
    provider: 'foundry-hosted-agents',
    calendarUserId: intent.userId,
    browserSessionId: intent.sessionId,
    foundrySession: 'server-managed',
    requestPreview: {
      agent: process.env.FOUNDRY_AGENT_ID ?? 'calendar-planner-demo-agent',
      endpoint: process.env.FOUNDRY_AGENT_ENDPOINT ?? 'offline-demo',
      affinity: 'cookie-backed browser session, Foundry agent_session_id retained server-side',
      toolContract: 'Return CalendarPatch[] only. Do not call calendar write APIs.',
      input: {
        intent,
        event,
        proposedPatchCount: patches.length,
      },
    },
  };
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
