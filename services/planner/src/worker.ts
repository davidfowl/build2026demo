import './otel';
import { createServer } from 'node:http';
import {
  type AppState,
  type CalendarEvent,
  type CalendarPatch,
  type PatchProposal,
  type PlanningIntent,
  appStateSchema,
  calendarEventSchema,
  demoSessionId,
  demoUserId,
  id,
  intentSchema,
  minutesBetween,
  moveWindow,
} from '@build2026/shared';

const apiBaseUrl = withoutTrailingSlash(process.env.API_BASE_URL ?? 'http://localhost:4310');
const plannerMode = process.env.PLANNER_MODE === 'foundry-hosted' ? 'foundry-hosted' : 'local';
const workerId = `${plannerMode}-planner-${process.pid}`;
const pollMs = Number(process.env.PLANNER_POLL_MS ?? 2000);

console.log(`[planner] ${workerId} using ${apiBaseUrl}`);
console.log('[planner] Planner is not a calendar write authority; it emits CalendarPatch[] proposals.');
startHostedAgentEndpoint();

for (;;) {
  try {
    await processOneIntent();
  } catch (error) {
    console.error('[planner] planning loop error', error);
  }
  await delay(pollMs);
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
        role: 'calendar-planner',
        mode: plannerMode,
        instruction: 'Emit CalendarPatch[] proposals only. The broker applies or rejects patches.',
        queuedIntents: state.intents.filter((intent) => intent.status === 'queued').length,
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
