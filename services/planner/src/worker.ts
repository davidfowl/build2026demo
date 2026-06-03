import './otel';
import { createServer } from 'node:http';
import { z } from 'zod';
import {
  type AppState,
  type CalendarEvent,
  type CalendarPatch,
  type MeetingReadinessJob,
  type PatchProposal,
  type PlanningIntent,
  type ReadinessSuggestion,
  appStateSchema,
  calendarEventSchema,
  demoSessionId,
  demoUserId,
  id,
  intentSchema,
  meetingReadinessJobSchema,
  minutesBetween,
  moveWindow,
} from '@build2026/shared';

const apiBaseUrl = withoutTrailingSlash(process.env.API_BASE_URL ?? 'http://localhost:4310');
const plannerMode = process.env.PLANNER_MODE === 'foundry-hosted' ? 'foundry-hosted' : 'local';
const workerId = `${plannerMode}-planner-${process.pid}`;
const pollMs = Number(process.env.PLANNER_POLL_MS ?? 2000);
const toolDelayMs = Number(process.env.READINESS_TOOL_DELAY_MS ?? 750);

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

console.log(`[planner] ${workerId} using ${apiBaseUrl}`);
console.log('[planner] Planner is not a calendar write authority; it emits CalendarPatch[] proposals and readiness suggestions.');
startHostedAgentEndpoint();

await Promise.all([runPlanningLoop(), runReadinessLoop()]);

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

function startHostedAgentEndpoint(): void {
  const portValue = process.env.DEFAULT_AD_PORT;
  if (!portValue) {
    return;
  }

  const port = Number(portValue);
  createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, workerId, mode: plannerMode }));
      return;
    }

    if (request.method === 'POST' && request.url?.startsWith('/responses')) {
      const state = await fetchState();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        role: 'meeting-readiness-planner',
        mode: plannerMode,
        instruction: 'Run meeting-readiness tools, return suggestions, and emit CalendarPatch[] only for calendar changes. The broker applies or rejects patches.',
        queuedIntents: state.intents.filter((intent) => intent.status === 'queued').length,
        queuedReadinessJobs: state.readinessJobs.filter((job) => job.status === 'queued').length,
      }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  }).listen(port, () => {
    console.log(`[planner] hosted-agent responses endpoint listening on http://localhost:${port}/responses`);
  });
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

  try {
    await runReadinessAnalysis(job);
  } catch (error) {
    await failReadinessJob(job.id, error instanceof Error ? error.message : 'Unknown readiness agent failure.');
    throw error;
  }
}

async function runReadinessAnalysis(job: MeetingReadinessJob): Promise<void> {
  if (!(await recordProgress(job.id, 'meeting', 'Reading meeting details', 'Loaded title, attendees, location, and agenda notes.'))) {
    return;
  }
  if (!(await continueAfterDelay(job.id))) {
    return;
  }
  const meeting = calendarEventSchema.parse(await fetchJson(`/api/agent/meetings/${encodeURIComponent(job.meetingId)}`));

  if (!(await recordProgress(job.id, 'calendar-window', 'Scanning the 7-day calendar', 'Looked for open focus windows and risky adjacent meetings.'))) {
    return;
  }
  if (!(await continueAfterDelay(job.id))) {
    return;
  }
  const calendarWindow = calendarWindowSchema.parse(await fetchJson(`/api/agent/calendar-window?meetingId=${encodeURIComponent(job.meetingId)}&days=7`));

  if (!(await recordProgress(job.id, 'weather', 'Checking meeting-day weather', 'Pulled location-specific weather so the advice is useful on the day.'))) {
    return;
  }
  if (!(await continueAfterDelay(job.id))) {
    return;
  }
  const weather = weatherSchema.parse(await fetchJson(`/api/agent/weather?meetingId=${encodeURIComponent(job.meetingId)}`));

  if (!(await recordProgress(job.id, 'travel', 'Estimating travel and setup buffer', 'Compared the previous event with the meeting location.'))) {
    return;
  }
  if (!(await continueAfterDelay(job.id))) {
    return;
  }
  const travel = travelSchema.parse(await fetchJson(`/api/agent/travel?meetingId=${encodeURIComponent(job.meetingId)}`));

  if (!(await recordProgress(job.id, 'materials', 'Reviewing agenda and materials', 'Checked the meeting notes for a checklist and open questions.'))) {
    return;
  }
  if (!(await continueAfterDelay(job.id))) {
    return;
  }
  const materials = materialsSchema.parse(await fetchJson(`/api/agent/materials?meetingId=${encodeURIComponent(job.meetingId)}`));

  if (!(await recordProgress(job.id, 'scoring', 'Scoring readiness suggestions', 'Ranked prep time, weather, travel, and agenda/materials recommendations.'))) {
    return;
  }
  if (!(await continueAfterDelay(job.id))) {
    return;
  }
  const suggestions = createReadinessSuggestions(job, meeting, calendarWindow, weather, travel, materials);

  await postJson(`/api/planner/readiness-jobs/${encodeURIComponent(job.id)}/result`, { suggestions });
  console.log(`[planner] completed readiness job ${job.id} with ${suggestions.length} suggestion(s)`);
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
    createdBy: plannerMode === 'foundry-hosted' ? 'foundry-hosted-agent' : 'local-planner-worker',
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
  const userIsolationKey = process.env.FOUNDRY_USER_ISOLATION_KEY ?? demoUserId;
  const chatIsolationKey = process.env.FOUNDRY_CHAT_ISOLATION_KEY ?? demoSessionId;

  return {
    provider: 'foundry-hosted-agents',
    userIsolationKey,
    chatIsolationKey,
    sandboxHome: `/home/agent/${userIsolationKey}/${chatIsolationKey}`,
    requestPreview: {
      agent: process.env.FOUNDRY_AGENT_ID ?? 'calendar-planner-demo-agent',
      endpoint: process.env.FOUNDRY_AGENT_ENDPOINT ?? 'offline-demo',
      isolation: {
        user: userIsolationKey,
        chat: chatIsolationKey,
      },
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
