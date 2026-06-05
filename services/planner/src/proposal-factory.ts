import {
  type AppState,
  type CalendarEvent,
  type CalendarPatch,
  type PatchProposal,
  type PlanningIntent,
  id,
  minutesBetween,
  moveWindow,
} from './shared';
import { resolveHostedAgentEndpoint } from './config';

// Builds CalendarPatch proposals only. The broker remains the calendar write
// authority and decides whether these patches can be applied.
export function createProposal(intent: PlanningIntent, event: CalendarEvent, state: AppState): PatchProposal {
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
      // Configured in apphost.mts as PLANNER_AGENT_ENDPOINT from hostedAgent.getEndpoint('http').
      endpoint: resolveHostedAgentEndpoint(),
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
