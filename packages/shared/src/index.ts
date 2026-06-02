import { z } from 'zod';

export const demoUserId = 'user-alex';
export const demoSessionId = 'chat-build-2026';
export const primaryCalendarId = 'cal-alex-primary';
export const teamCalendarId = 'cal-team-launch';

export const eventKindSchema = z.enum(['focus', 'task', 'draft', 'meeting', 'team']);
export type EventKind = z.infer<typeof eventKindSchema>;

export const calendarEventSchema = z.object({
  id: z.string(),
  calendarId: z.string(),
  ownerId: z.string(),
  title: z.string(),
  kind: eventKindSchema,
  start: z.string(),
  end: z.string(),
  etag: z.string(),
  attendees: z.array(z.string()).default([]),
  location: z.string().optional(),
  description: z.string().optional(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const intentSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  source: z.enum(['drag', 'command']),
  eventId: z.string(),
  desiredStart: z.string(),
  desiredEnd: z.string(),
  etagAtIntent: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  status: z.enum(['queued', 'planning', 'completed', 'failed']),
});
export type PlanningIntent = z.infer<typeof intentSchema>;

export const patchOperationSchema = z.enum(['move', 'create', 'delete', 'update']);
export type PatchOperation = z.infer<typeof patchOperationSchema>;

export const calendarPatchSchema = z.object({
  id: z.string(),
  intentId: z.string(),
  operation: patchOperationSchema,
  eventId: z.string().optional(),
  baseEtag: z.string().optional(),
  changes: z.object({
    title: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    calendarId: z.string().optional(),
    attendees: z.array(z.string()).optional(),
    location: z.string().optional(),
    description: z.string().optional(),
  }),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type CalendarPatch = z.infer<typeof calendarPatchSchema>;

export const proposalSchema = z.object({
  id: z.string(),
  intentId: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  plannerMode: z.enum(['local', 'foundry-hosted']),
  patches: z.array(calendarPatchSchema),
  hostedAgentSession: z
    .object({
      provider: z.literal('foundry-hosted-agents'),
      userIsolationKey: z.string(),
      chatIsolationKey: z.string(),
      sandboxHome: z.string(),
      requestPreview: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
export type PatchProposal = z.infer<typeof proposalSchema>;

export const brokerDecisionSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  patchId: z.string(),
  intentId: z.string(),
  eventId: z.string().optional(),
  status: z.enum(['applied', 'needs-confirmation', 'rejected']),
  policy: z.string(),
  reason: z.string(),
  createdAt: z.string(),
  canConfirm: z.boolean(),
});
export type BrokerDecision = z.infer<typeof brokerDecisionSchema>;

export const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  message: z.string(),
  patchId: z.string().optional(),
  eventId: z.string().optional(),
  previousEvent: calendarEventSchema.optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const appStateSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  events: z.array(calendarEventSchema),
  intents: z.array(intentSchema),
  proposals: z.array(proposalSchema),
  decisions: z.array(brokerDecisionSchema),
  audit: z.array(auditEntrySchema),
  lastDragIntentId: z.string().optional(),
});
export type AppState = z.infer<typeof appStateSchema>;

export const createIntentRequestSchema = z.object({
  userId: z.string().default(demoUserId),
  sessionId: z.string().default(demoSessionId),
  eventId: z.string(),
  desiredStart: z.string(),
  desiredEnd: z.string(),
  source: z.enum(['drag', 'command']).default('drag'),
});
export type CreateIntentRequest = z.infer<typeof createIntentRequestSchema>;

export const submitProposalRequestSchema = z.object({
  proposal: proposalSchema,
});
export type SubmitProposalRequest = z.infer<typeof submitProposalRequestSchema>;

export const policyDecisionKindSchema = z.enum(['auto-apply', 'confirm', 'reject']);
export type PolicyDecisionKind = z.infer<typeof policyDecisionKindSchema>;

export type PolicyEvaluation = {
  kind: PolicyDecisionKind;
  policy: string;
  reason: string;
  canConfirm: boolean;
};

export function createSeedState(now = new Date('2026-06-02T09:00:00-07:00')): AppState {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const at = (hour: number, minute = 0) => {
    const d = new Date(day);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    userId: demoUserId,
    sessionId: demoSessionId,
    events: [
      event('focus-1', primaryCalendarId, demoUserId, 'Write Aspire agents intro', 'focus', at(9), at(10, 30)),
      event('meeting-1', primaryCalendarId, demoUserId, 'Build keynote sync', 'meeting', at(11), at(12), {
        attendees: ['nikki@example.com', 'scott@example.com'],
        location: 'Teams',
      }),
      event('task-1', primaryCalendarId, demoUserId, 'Polish calendar drag demo', 'task', at(13), at(14)),
      event('draft-1', primaryCalendarId, demoUserId, 'Draft follow-up email', 'draft', at(15), at(15, 30)),
      event('team-1', teamCalendarId, 'team-build', 'Shared booth coverage', 'team', at(14), at(15), {
        attendees: ['team@example.com'],
        location: 'Expo hall',
      }),
    ],
    intents: [],
    proposals: [],
    decisions: [],
    audit: [
      {
        id: id('audit'),
        at: new Date().toISOString(),
        actor: 'demo-seed',
        action: 'seed',
        message: 'Seeded the Build 2026 calendar demo.',
      },
    ],
  };
}

function event(
  id: string,
  calendarId: string,
  ownerId: string,
  title: string,
  kind: EventKind,
  start: string,
  end: string,
  extras: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    calendarId,
    ownerId,
    title,
    kind,
    start,
    end,
    etag: makeEtag(id, 1),
    attendees: [],
    ...extras,
  };
}

export function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeEtag(idPart: string, version: number): string {
  return `"${idPart}:${version}"`;
}

export function nextEtag(etag: string): string {
  const match = /^(?:"?)(?<id>[^:"]+):(?<version>\d+)(?:"?)$/.exec(etag);
  if (!match?.groups) {
    return makeEtag('event', Date.now());
  }
  return makeEtag(match.groups.id, Number(match.groups.version) + 1);
}

export function evaluatePatch(event: CalendarEvent | undefined, patch: CalendarPatch, userId: string): PolicyEvaluation {
  const changedFields = Object.keys(patch.changes);

  if (patch.operation === 'create') {
    return {
      kind: 'confirm',
      policy: 'create-requires-confirmation',
      reason: 'Creating calendar items is held for user confirmation.',
      canConfirm: true,
    };
  }

  if (!event) {
    return {
      kind: 'reject',
      policy: 'event-not-found',
      reason: 'The target event no longer exists.',
      canConfirm: false,
    };
  }

  if (event.calendarId !== primaryCalendarId || event.kind === 'team') {
    return {
      kind: 'reject',
      policy: 'shared-calendar-blocked',
      reason: 'Shared or team calendar changes require a stronger delegated authorization path.',
      canConfirm: false,
    };
  }

  if (event.ownerId !== userId) {
    return {
      kind: 'reject',
      policy: 'not-owner',
      reason: 'The signed-in user does not own this event.',
      canConfirm: false,
    };
  }

  if (patch.baseEtag && patch.baseEtag !== event.etag) {
    return {
      kind: 'reject',
      policy: 'stale-etag',
      reason: `The patch was based on ${patch.baseEtag}, but the calendar item is now ${event.etag}.`,
      canConfirm: false,
    };
  }

  if (patch.operation === 'delete') {
    return {
      kind: 'confirm',
      policy: 'delete-requires-confirmation',
      reason: 'Deleting events always requires confirmation.',
      canConfirm: true,
    };
  }

  if (changedFields.some((field) => ['attendees', 'location', 'description'].includes(field))) {
    return {
      kind: 'confirm',
      policy: 'sensitive-field-requires-confirmation',
      reason: 'Attendees, location, and description changes require confirmation.',
      canConfirm: true,
    };
  }

  if (event.kind === 'meeting' || event.attendees.length > 0) {
    return {
      kind: 'confirm',
      policy: 'meeting-move-requires-confirmation',
      reason: 'Moving an accepted meeting with attendees requires user confirmation.',
      canConfirm: true,
    };
  }

  if (patch.operation === 'move' && ['draft', 'focus', 'task'].includes(event.kind)) {
    return {
      kind: 'auto-apply',
      policy: 'owned-draft-focus-task-auto-apply',
      reason: 'User-owned draft, focus, and task blocks can move automatically with undo.',
      canConfirm: false,
    };
  }

  return {
    kind: 'confirm',
    policy: 'default-confirmation',
    reason: 'This operation is safe to propose, but not safe to apply automatically.',
    canConfirm: true,
  };
}

export function minutesBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 60000);
}

export function moveWindow(original: CalendarEvent, desiredStart: string, desiredEnd?: string): { start: string; end: string } {
  const startMs = Date.parse(desiredStart);
  const durationMs = desiredEnd ? Date.parse(desiredEnd) - startMs : Date.parse(original.end) - Date.parse(original.start);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + durationMs).toISOString(),
  };
}
