import './otel';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  SpanStatusCode,
  context as otelContext,
  propagation,
  trace,
  type Span,
  type TextMapGetter,
} from '@opentelemetry/api';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_WORKFLOW_NAME,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OUTPUT_TYPE_VALUE_JSON,
} from '@opentelemetry/semantic-conventions/incubating';
import { z } from 'zod';
import type { CopilotSession, TelemetryConfig, TraceContext } from '@github/copilot-sdk';
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
const plannerRole = process.env.PLANNER_ROLE === 'agent' ? 'agent' : 'worker';
const copilotModel = process.env.COPILOT_MODEL ?? 'default';
const workerId = `${plannerRole === 'agent' ? 'hosted-agent' : 'planner-worker'}-${process.pid}`;
const pollMs = Number(process.env.PLANNER_POLL_MS ?? 5000);
const toolDelayMs = Number(process.env.READINESS_TOOL_DELAY_MS ?? 750);
const copilotOtelFlushDelayMs = Number(process.env.COPILOT_OTEL_FLUSH_DELAY_MS ?? 1500);
const hostedAgentSessions = new Map<string, string>();
const tracer = trace.getTracer('build2026-planner-agent');
const copilotSystemName = 'github.copilot';
const copilotAgentName = 'build2026-meeting-readiness';
const incomingHeaderGetter: TextMapGetter<IncomingHttpHeaders> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => {
    const value = carrier[key.toLowerCase()];
    return Array.isArray(value) ? value.join(',') : value;
  },
};

const calendarWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
  events: z.array(calendarEventSchema),
});

const weatherSchema = z.object({
  location: z.string(),
  forecastAt: z.string(),
  condition: z.string(),
  temperatureF: z.number(),
  precipitationChance: z.number(),
  recommendation: z.string(),
});

const travelSchema = z.object({
  from: z.string(),
  to: z.string(),
  previousEvent: z.object({ id: z.string(), title: z.string(), end: z.string() }).nullable(),
  travelMinutes: z.number(),
  leaveAt: z.string(),
  recommendation: z.string(),
});

const materialsSchema = z.object({
  topic: z.string(),
  agendaStatus: z.string(),
  checklist: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

const copilotReadinessResponseSchema = z.object({
  suggestions: z.array(readinessSuggestionSchema).min(1),
});

console.log(`[planner] ${workerId} role=${plannerRole} hosted-agent path using ${apiBaseUrl}`);
console.log('[planner] Planner is not a calendar write authority; it emits CalendarPatch[] proposals and readiness suggestions.');

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
        response.end(JSON.stringify({ status: 'ready', workerId, runtime: 'foundry-hosted-agent' }));
        return;
      }

      if (request.method === 'POST' && request.url?.includes('/invocations')) {
        const body = hostedAgentInvocationRequestSchema.parse(await readJsonBody(request));
        const agentContext = extractHostedAgentContext(body);
        const sessionId = getHostedAgentSessionId(request.url, body);
        console.log(`[planner-agent] invocation received job=${agentContext.job.id} meeting=${agentContext.meeting.id} session=${sessionId}.`);
        const traceContext = propagation.extract(otelContext.active(), request.headers, incomingHeaderGetter);
        const suggestions = await otelContext.with(traceContext, () => createHostedAgentSuggestions(agentContext));
        const content = JSON.stringify({ suggestions });
        console.log(`[planner-agent] invocation completed job=${agentContext.job.id} suggestions=${suggestions.length}: ${suggestionTitles(suggestions)}`);

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

async function createHostedAgentSuggestions(context: HostedAgentContext): Promise<ReadinessSuggestion[]> {
  const suggestions = await runCopilotSdkPlanner(context);
  console.log(`[planner-agent] Copilot SDK authored job=${context.job.id} model=${copilotModel} suggestions=${suggestions.length}: ${suggestionTitles(suggestions)}`);
  return suggestions;
}

async function runCopilotSdkPlanner(context: HostedAgentContext): Promise<ReadinessSuggestion[]> {
  const prompt = copilotPlannerPrompt(context);
  return tracer.startActiveSpan('copilot.sdk.invoke_agent', {
    attributes: {
      'app.readiness.job_id': context.job.id,
      'app.meeting.id': context.meeting.id,
      [ATTR_GEN_AI_SYSTEM]: copilotSystemName,
      [ATTR_GEN_AI_PROVIDER_NAME]: copilotSystemName,
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
      [ATTR_GEN_AI_AGENT_NAME]: copilotAgentName,
      [ATTR_GEN_AI_REQUEST_MODEL]: copilotModel,
      [ATTR_GEN_AI_OUTPUT_TYPE]: GEN_AI_OUTPUT_TYPE_VALUE_JSON,
      [ATTR_GEN_AI_WORKFLOW_NAME]: 'meeting-readiness',
      [ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]: 'Return structured readiness suggestions as JSON; never call calendar write APIs.',
      'copilot.model': copilotModel,
    },
  }, async (span) => {
    const { CopilotClient, approveAll } = await import('@github/copilot-sdk');
    const telemetry = copilotTelemetryConfig();
    span.setAttribute('copilot.telemetry.enabled', Boolean(telemetry));
    if (telemetry) {
      span.setAttribute('copilot.telemetry.exporter', telemetry.exporterType ?? 'otlp-http');
      span.setAttribute('copilot.telemetry.source', telemetry.sourceName ?? 'github.copilot');
      span.setAttribute('copilot.telemetry.capture_content', telemetry.captureContent ?? false);
      span.setAttribute('copilot.telemetry.flush_delay_ms', copilotOtelFlushDelayMs);
    }
    console.log(`[planner-agent] Copilot SDK telemetry ${telemetry ? `enabled source=${telemetry.sourceName} exporter=${telemetry.exporterType}` : 'disabled'}.`);
    const client = new CopilotClient({
      ...(telemetry ? { env: copilotRuntimeEnv(), telemetry } : {}),
      onGetTraceContext: currentTraceContext,
    });
    let session: CopilotSession | undefined;
    const shouldFlushCopilotTelemetry = (telemetry.exporterType ?? 'otlp-http') === 'otlp-http';

    try {
      session = await client.createSession({
        clientName: copilotAgentName,
        ...(process.env.COPILOT_MODEL ? { model: copilotModel } : {}),
        onPermissionRequest: approveAll,
        enableSessionTelemetry: true,
        skipCustomInstructions: true,
        enableConfigDiscovery: false,
        enableSkills: false,
      });
      span.addEvent(EVENT_GEN_AI_USER_MESSAGE, {
        [ATTR_GEN_AI_SYSTEM]: copilotSystemName,
        'app.readiness.job_id': context.job.id,
        'app.meeting.id': context.meeting.id,
        'app.meeting.title': context.meeting.title,
      });
      const response = await session.sendAndWait({ prompt }, Number(process.env.COPILOT_TIMEOUT_MS ?? 120000));
      const content = response?.data.content.trim();
      if (!content) {
        throw new Error('Copilot SDK returned an empty readiness response.');
      }
      const suggestions = parseCopilotReadinessSuggestions(content);
      span.addEvent(EVENT_GEN_AI_ASSISTANT_MESSAGE, {
        [ATTR_GEN_AI_SYSTEM]: copilotSystemName,
        [ATTR_GEN_AI_OUTPUT_TYPE]: GEN_AI_OUTPUT_TYPE_VALUE_JSON,
        'app.readiness.suggestions.count': suggestions.length,
      });
      span.setAttribute('copilot.response.length', content.length);
      span.setAttribute('copilot.suggestions.count', suggestions.length);
      span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, copilotModel);
      return suggestions;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (shouldFlushCopilotTelemetry) {
        await delay(copilotOtelFlushDelayMs);
      }
      if (session) {
        await session.disconnect();
      }
      const errors = await client.stop();
      for (const error of errors) {
        console.error('[planner-agent] Copilot SDK cleanup error', error);
      }
      span.end();
    }
  });
}

function copilotTelemetryConfig(): TelemetryConfig {
  const captureContent = booleanEnv('COPILOT_OTEL_CAPTURE_CONTENT')
    ?? booleanEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT')
    ?? true;
  const otlpEndpoint = normalizeOtlpHttpEndpoint(firstEnv(
    'COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    ...(process.env.OTEL_EXPORTER_OTLP_PROTOCOL === 'grpc' ? [] : ['OTEL_EXPORTER_OTLP_ENDPOINT']),
  ));
  if (!otlpEndpoint) {
    throw new Error('Copilot SDK telemetry requires COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT or an OTLP HTTP endpoint.');
  }

  return {
    otlpEndpoint,
    exporterType: 'otlp-http',
    sourceName: process.env.COPILOT_OTEL_SOURCE_NAME ?? 'build2026-planner-agent-copilot-sdk',
    captureContent,
  };
}

function normalizeOtlpHttpEndpoint(endpoint: string | undefined): string | undefined {
  const normalized = endpoint?.trim().replace(/\/+$/, '');
  return normalized?.endsWith('/v1/traces') ? normalized.slice(0, -'/v1/traces'.length) : normalized;
}

function copilotRuntimeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    OTEL_BSP_SCHEDULE_DELAY: process.env.COPILOT_OTEL_BSP_SCHEDULE_DELAY ?? '100',
    OTEL_BSP_EXPORT_TIMEOUT: process.env.COPILOT_OTEL_BSP_EXPORT_TIMEOUT ?? process.env.OTEL_BSP_EXPORT_TIMEOUT ?? '30000',
    OTEL_EXPORTER_OTLP_PROTOCOL: process.env.COPILOT_OTEL_EXPORTER_PROTOCOL ?? 'http/protobuf',
  };
}

function currentTraceContext(): TraceContext {
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
  return {
    traceparent: carrier.traceparent,
    tracestate: carrier.tracestate,
  };
}

function booleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function copilotPlannerPrompt(context: HostedAgentContext): string {
  return `
You are the meeting readiness planner for an Aspire Build 2026 demo.
Review the scoped meeting context and return broker-reviewed readiness suggestions.
Do not call tools. Do not call calendar write APIs. Do not return prose or markdown.
Return only a JSON object with a "suggestions" array matching this TypeScript shape:

type ReadinessSuggestion = {
  id: string;
  kind: "prep-time" | "weather-attire" | "travel-buffer" | "agenda-materials";
  title: string;
  detail: string;
  rationale?: string;
  proposedPatch?: {
    id: string;
    intentId: string;
    operation: "create" | "move" | "delete" | "update";
    eventId?: string;
    baseEtag?: string;
    changes: {
      title?: string;
      start?: string;
      end?: string;
      calendarId?: string;
      kind?: "focus" | "task" | "draft" | "meeting" | "team" | "prep";
      attendees?: string[];
      location?: string;
      description?: string;
    };
    reason: string;
    confidence: number;
  };
};

Create suggestions for prep time, weather/attire, travel/setup, and agenda/materials when supported by the context.
For proposed calendar changes, use intentId "${context.job.id}", calendarId "${context.meeting.calendarId}", ISO timestamps, and kind "prep".

Context:
${JSON.stringify({
    meeting: context.meeting,
    calendarWindow: context.calendarWindow,
    weather: context.weather,
    travel: context.travel,
    materials: context.materials,
  })}
`.trim();
}

function parseCopilotReadinessSuggestions(content: string): ReadinessSuggestion[] {
  const parsed = copilotReadinessResponseSchema.parse(JSON.parse(extractJsonObject(content)));
  return parsed.suggestions;
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedJson) {
    return fencedJson[1].trim();
  }

  throw new Error('Copilot SDK readiness response must be a JSON object.');
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
  return tracer.startActiveSpan('calendar.readiness.analyze', {
    attributes: {
      'app.readiness.job_id': job.id,
      'app.meeting.id': job.meetingId,
      'app.session.id': job.sessionId,
      'app.user.id': job.userId,
    },
  }, async (span) => {
    try {
      console.log(`[planner] starting readiness analysis job=${job.id} meeting=${job.meetingId} via hosted agent.`);
      const context = await loadReadinessContext(job);
      if (!context) {
        console.log(`[planner] readiness job ${job.id} stopped before context load completed.`);
        return;
      }
      span.setAttribute('app.meeting.title', context.meeting.title);
      console.log(`[planner] loaded readiness context job=${job.id} meeting="${context.meeting.title}" calendarEvents=${context.calendarWindow.events.length} weather="${context.weather.condition}" travelMinutes=${context.travel.travelMinutes}.`);

      if (!(await recordProgress(job.id, 'hosted-agent', 'Invoking Foundry hosted agent', 'Sent the scoped meeting context to the isolated hosted-agent session.'))) {
        return;
      }
      const suggestions = await invokeHostedAgent(context);
      span.setAttribute('app.readiness.suggestions.count', suggestions.length);
      if (!(await recordProgress(job.id, 'agent-result', 'Received hosted-agent result', `Validated ${suggestions.length} readiness suggestion(s) from the hosted agent.`))) {
        return;
      }

      await postJson(`/api/planner/readiness-jobs/${encodeURIComponent(job.id)}/result`, { suggestions });
      console.log(`[planner] completed readiness job ${job.id} with ${suggestions.length} suggestion(s): ${suggestionTitles(suggestions)}`);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function loadReadinessContext(job: MeetingReadinessJob): Promise<HostedAgentContext | undefined> {
  const meeting = await runReadinessStep(
    job,
    'meeting',
    'Reading meeting details',
    'Loaded title, attendees, location, and agenda notes.',
    'calendar.readiness.load_meeting',
    async () => calendarEventSchema.parse(await fetchJson(`/api/agent/meetings/${encodeURIComponent(job.meetingId)}`)),
  );
  if (!meeting) {
    return undefined;
  }

  const calendarWindow = await runReadinessStep(
    job,
    'calendar-window',
    'Scanning the 7-day calendar',
    'Looked for open focus windows and risky adjacent meetings.',
    'calendar.readiness.scan_calendar',
    async () => calendarWindowSchema.parse(await fetchJson(`/api/agent/calendar-window?meetingId=${encodeURIComponent(job.meetingId)}&days=7`)),
  );
  if (!calendarWindow) {
    return undefined;
  }

  const weather = await runReadinessStep(
    job,
    'weather',
    'Checking meeting-day weather',
    'Pulled location-specific weather so the advice is useful on the day.',
    'calendar.readiness.check_weather',
    async () => weatherSchema.parse(await fetchJson(`/api/agent/weather?meetingId=${encodeURIComponent(job.meetingId)}`)),
  );
  if (!weather) {
    return undefined;
  }

  const travel = await runReadinessStep(
    job,
    'travel',
    'Estimating travel and setup buffer',
    'Compared the previous event with the meeting location.',
    'calendar.readiness.estimate_travel',
    async () => travelSchema.parse(await fetchJson(`/api/agent/travel?meetingId=${encodeURIComponent(job.meetingId)}`)),
  );
  if (!travel) {
    return undefined;
  }

  const materials = await runReadinessStep(
    job,
    'materials',
    'Reviewing agenda and materials',
    'Checked the meeting notes for a checklist and open questions.',
    'calendar.readiness.review_materials',
    async () => materialsSchema.parse(await fetchJson(`/api/agent/materials?meetingId=${encodeURIComponent(job.meetingId)}`)),
  );
  if (!materials) {
    return undefined;
  }

  return hostedAgentContextSchema.parse({ job, meeting, calendarWindow, weather, travel, materials });
}

async function runReadinessStep<T>(
  job: MeetingReadinessJob,
  stepId: string,
  label: string,
  detail: string,
  spanName: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  return tracer.startActiveSpan(spanName, {
    attributes: {
      'app.readiness.job_id': job.id,
      'app.readiness.step_id': stepId,
      'app.meeting.id': job.meetingId,
    },
  }, async (span) => {
    try {
      if (!(await recordProgress(job.id, stepId, label, detail))) {
        span.setAttribute('app.readiness.stopped', true);
        return undefined;
      }
      if (!(await continueAfterDelay(job.id))) {
        span.setAttribute('app.readiness.stopped', true);
        return undefined;
      }
      return await action();
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
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

  throw new Error('Hosted-agent readiness requires PLANNER_AGENT_ENDPOINT or a planner-agent service reference.');
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

let cachedFoundryToken: { token: string; expiresOnTimestamp: number } | undefined;

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
    createdBy: 'foundry-hosted-agent',
    patches,
    hostedAgentSession: hostedAgentSession(intent, event, patches),
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
