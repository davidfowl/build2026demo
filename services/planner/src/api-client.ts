import { z } from 'zod';
import {
  appStateSchema,
  brokerDecisionSchema,
  calendarEventSchema,
  hostedAgentCalendarWindowSchema,
  hostedAgentMaterialsSchema,
  hostedAgentTravelSchema,
  hostedAgentWeatherSchema,
  intentSchema,
  meetingReadinessJobSchema,
  readinessFailureRequestSchema,
  readinessProgressRequestSchema,
  readinessResultRequestSchema,
  submitProposalRequestSchema,
  type AppState,
  type BrokerDecision,
  type CalendarEvent,
  type HostedAgentCalendarWindow,
  type HostedAgentMaterials,
  type HostedAgentTravel,
  type HostedAgentWeather,
  type MeetingReadinessJob,
  type PatchProposal,
  type ReadinessProgressRequest,
  type ReadinessSuggestion,
} from './shared';
import { requiredEnv, withoutTrailingSlash } from './config';

// apphost.mts injects API_BASE_URL from api.getEndpoint('http') for the worker.
// All broker calls stay relative to that configured endpoint.
const apiBaseUrl = withoutTrailingSlash(requiredEnv('API_BASE_URL'));

const claimedPlanningIntentSchema = z.object({
  intent: intentSchema,
  event: calendarEventSchema,
});
export type ClaimedPlanningIntent = z.infer<typeof claimedPlanningIntentSchema>;

const claimedReadinessJobSchema = z.object({
  job: meetingReadinessJobSchema,
});

const readinessJobResponseSchema = z.object({
  job: meetingReadinessJobSchema,
});

const submitProposalResponseSchema = z.object({
  decisions: z.array(brokerDecisionSchema),
});

export function configuredApiBaseUrl(): string {
  return apiBaseUrl;
}

function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

export async function fetchState(): Promise<AppState> {
  return getJson('/api/state', appStateSchema);
}

export async function claimNextPlanningIntent(workerId: string): Promise<ClaimedPlanningIntent | undefined> {
  return getOptionalJson(`/api/planner/next-intent?workerId=${encodeURIComponent(workerId)}`, claimedPlanningIntentSchema);
}

export async function submitProposal(proposal: PatchProposal): Promise<BrokerDecision[]> {
  const body = submitProposalRequestSchema.parse({ proposal });
  return (await postJson('/api/planner/proposals', body, submitProposalResponseSchema)).decisions;
}

export async function claimNextReadinessJob(workerId: string): Promise<MeetingReadinessJob | undefined> {
  const claimed = await getOptionalJson(`/api/planner/next-readiness-job?workerId=${encodeURIComponent(workerId)}`, claimedReadinessJobSchema);
  return claimed?.job;
}

export async function recordReadinessProgress(jobId: string, progress: ReadinessProgressRequest): Promise<MeetingReadinessJob> {
  const body = readinessProgressRequestSchema.parse(progress);
  return (await postJson(`/api/planner/readiness-jobs/${encodeURIComponent(jobId)}/progress`, body, readinessJobResponseSchema)).job;
}

export async function completeReadinessJob(jobId: string, suggestions: ReadinessSuggestion[]): Promise<MeetingReadinessJob> {
  const body = readinessResultRequestSchema.parse({ suggestions });
  return (await postJson(`/api/planner/readiness-jobs/${encodeURIComponent(jobId)}/result`, body, readinessJobResponseSchema)).job;
}

export async function failReadinessJob(jobId: string, error: string): Promise<MeetingReadinessJob> {
  const body = readinessFailureRequestSchema.parse({ error });
  return (await postJson(`/api/planner/readiness-jobs/${encodeURIComponent(jobId)}/fail`, body, readinessJobResponseSchema)).job;
}

export async function getMeeting(meetingId: string): Promise<CalendarEvent> {
  return getJson(`/api/agent/meetings/${encodeURIComponent(meetingId)}`, calendarEventSchema);
}

export async function getCalendarWindow(meetingId: string, days: number): Promise<HostedAgentCalendarWindow> {
  return getJson(`/api/agent/calendar-window?meetingId=${encodeURIComponent(meetingId)}&days=${encodeURIComponent(String(days))}`, hostedAgentCalendarWindowSchema);
}

export async function getWeather(meetingId: string): Promise<HostedAgentWeather> {
  return getJson(`/api/agent/weather?meetingId=${encodeURIComponent(meetingId)}`, hostedAgentWeatherSchema);
}

export async function getTravel(meetingId: string): Promise<HostedAgentTravel> {
  return getJson(`/api/agent/travel?meetingId=${encodeURIComponent(meetingId)}`, hostedAgentTravelSchema);
}

export async function getMaterials(meetingId: string): Promise<HostedAgentMaterials> {
  return getJson(`/api/agent/materials?meetingId=${encodeURIComponent(meetingId)}`, hostedAgentMaterialsSchema);
}

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(apiUrl(path));
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return schema.parse(await response.json());
}

async function getOptionalJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const response = await fetch(apiUrl(path));
  if (response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return schema.parse(await response.json());
}

async function postJson<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return schema.parse(await response.json());
}
