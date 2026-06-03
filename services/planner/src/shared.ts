import { z } from 'zod';

export const demoUserId = 'user-alex';
export const demoSessionId = 'chat-build-2026';
export const primaryCalendarId = 'cal-alex-primary';
export const teamCalendarId = 'cal-team-launch';

export const eventKindSchema = z.enum(['focus', 'task', 'draft', 'meeting', 'team', 'prep']);
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
    kind: eventKindSchema.optional(),
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
  plannerMode: z.enum(['local', 'foundry-hosted', 'copilot-sdk']),
  patches: z.array(calendarPatchSchema),
  hostedAgentSession: z
    .object({
      provider: z.literal('foundry-hosted-agents'),
      calendarUserId: z.string(),
      browserSessionId: z.string(),
      foundrySession: z.literal('server-managed'),
      requestPreview: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
export type PatchProposal = z.infer<typeof proposalSchema>;

export const readinessSuggestionKindSchema = z.enum(['prep-time', 'weather-attire', 'travel-buffer', 'agenda-materials']);
export type ReadinessSuggestionKind = z.infer<typeof readinessSuggestionKindSchema>;

export const readinessStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  completedAt: z.string(),
});
export type ReadinessStep = z.infer<typeof readinessStepSchema>;

export const readinessSuggestionSchema = z.object({
  id: z.string(),
  kind: readinessSuggestionKindSchema,
  title: z.string(),
  detail: z.string(),
  rationale: z.string().optional(),
  proposedPatch: calendarPatchSchema.optional(),
  decisionId: z.string().optional(),
});
export type ReadinessSuggestion = z.infer<typeof readinessSuggestionSchema>;

export const meetingReadinessJobSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  meetingId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  workerId: z.string().optional(),
  currentStep: z.string().optional(),
  completedSteps: z.array(readinessStepSchema).default([]),
  suggestions: z.array(readinessSuggestionSchema).default([]),
  error: z.string().optional(),
});
export type MeetingReadinessJob = z.infer<typeof meetingReadinessJobSchema>;

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
  readinessJobs: z.array(meetingReadinessJobSchema).default([]),
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

export const createReadinessJobRequestSchema = z.object({
  userId: z.string().default(demoUserId),
  sessionId: z.string().default(demoSessionId),
});
export type CreateReadinessJobRequest = z.infer<typeof createReadinessJobRequestSchema>;

const isoDateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Expected an ISO date/time value.',
});

export const bookMeetingRequestSchema = z.object({
  userId: z.string().default(demoUserId),
  sessionId: z.string().default(demoSessionId),
  title: z.string().trim().min(1).max(140),
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  attendees: z.array(z.string().trim().min(1)).default([]),
  location: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
}).superRefine((request, context) => {
  if (Date.parse(request.end) <= Date.parse(request.start)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end'],
      message: 'Meeting end must be after start.',
    });
  }
});
export type BookMeetingRequest = z.infer<typeof bookMeetingRequestSchema>;

export const deleteEventRequestSchema = z.object({
  userId: z.string().default(demoUserId),
  sessionId: z.string().default(demoSessionId),
  confirmed: z.boolean().default(false),
});
export type DeleteEventRequest = z.infer<typeof deleteEventRequestSchema>;

export const readinessProgressRequestSchema = z.object({
  stepId: z.string(),
  label: z.string(),
  detail: z.string(),
});
export type ReadinessProgressRequest = z.infer<typeof readinessProgressRequestSchema>;

export const readinessResultRequestSchema = z.object({
  suggestions: z.array(readinessSuggestionSchema),
});
export type ReadinessResultRequest = z.infer<typeof readinessResultRequestSchema>;

export const readinessFailureRequestSchema = z.object({
  error: z.string(),
});
export type ReadinessFailureRequest = z.infer<typeof readinessFailureRequestSchema>;

export const hostedAgentContextSchema = z.object({
  job: meetingReadinessJobSchema,
  meeting: calendarEventSchema,
  calendarWindow: z.object({
    start: z.string(),
    end: z.string(),
    events: z.array(calendarEventSchema),
  }),
  weather: z.object({
    location: z.string(),
    forecastAt: z.string(),
    condition: z.string(),
    temperatureF: z.number(),
    precipitationChance: z.number(),
    recommendation: z.string(),
  }),
  travel: z.object({
    from: z.string(),
    to: z.string(),
    previousEvent: z.object({ id: z.string(), title: z.string(), end: z.string() }).nullable(),
    travelMinutes: z.number(),
    leaveAt: z.string(),
    recommendation: z.string(),
  }),
  materials: z.object({
    topic: z.string(),
    agendaStatus: z.string(),
    checklist: z.array(z.string()),
    openQuestions: z.array(z.string()),
  }),
});
export type HostedAgentContext = z.infer<typeof hostedAgentContextSchema>;

export const hostedAgentInvocationRequestSchema = z.object({
  input: z.union([z.string(), hostedAgentContextSchema]).optional(),
  message: z.string().optional(),
  context: hostedAgentContextSchema.optional(),
  session_id: z.string().optional(),
});
export type HostedAgentInvocationRequest = z.infer<typeof hostedAgentInvocationRequestSchema>;

export const hostedAgentInvocationResponseSchema = z.object({
  invocation_id: z.string(),
  session_id: z.string().optional(),
  output: z.object({
    role: z.literal('assistant'),
    content: z.string(),
  }),
  suggestions: z.array(readinessSuggestionSchema).optional(),
});
export type HostedAgentInvocationResponse = z.infer<typeof hostedAgentInvocationResponseSchema>;

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
  const at = (dayOffset: number, hour: number, minute = 0) => {
    const d = new Date(day);
    d.setDate(day.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    userId: demoUserId,
    sessionId: demoSessionId,
    events: [
      event('focus-1', primaryCalendarId, demoUserId, 'Write Aspire agents intro', 'focus', at(0, 9), at(0, 10, 30)),
      event('meeting-1', primaryCalendarId, demoUserId, 'Build keynote sync', 'meeting', at(0, 11), at(0, 12), {
        attendees: ['nikki@example.com', 'scott@example.com'],
        location: 'Teams',
      }),
      event('task-1', primaryCalendarId, demoUserId, 'Polish calendar drag demo', 'task', at(0, 13), at(0, 14)),
      event('draft-1', primaryCalendarId, demoUserId, 'Draft follow-up email', 'draft', at(0, 15), at(0, 15, 30)),
      event('focus-2', primaryCalendarId, demoUserId, 'Review customer feedback notes', 'focus', at(1, 9, 30), at(1, 10, 30)),
      event('meeting-2', primaryCalendarId, demoUserId, 'Design critique', 'meeting', at(1, 13), at(1, 14), {
        attendees: ['maya@example.com'],
        location: 'Teams',
      }),
      event('task-2', primaryCalendarId, demoUserId, 'Tighten readiness cards', 'task', at(2, 9), at(2, 10)),
      event('focus-3', primaryCalendarId, demoUserId, 'Demo rehearsal block', 'focus', at(2, 11), at(2, 12)),
      event('meeting-demo-review', primaryCalendarId, demoUserId, 'Build 2026 demo readiness review', 'meeting', at(3, 15), at(3, 16), {
        attendees: ['nikki@example.com', 'scott@example.com', 'maya@example.com'],
        location: 'Microsoft Reactor - Seattle',
        description: 'Review the Aspire agent demo story, readiness cards, and broker safety boundary.',
      }),
      event('team-1', teamCalendarId, 'team-build', 'Shared booth coverage', 'team', at(3, 13), at(3, 14), {
        attendees: ['team@example.com'],
        location: 'Expo hall',
      }),
      event('focus-4', primaryCalendarId, demoUserId, 'Build 2026 slide polish', 'focus', at(4, 10), at(4, 11, 30)),
      event('task-3', primaryCalendarId, demoUserId, 'Pack demo kit', 'task', at(5, 14), at(5, 14, 45)),
    ],
    intents: [],
    proposals: [],
    decisions: [],
    readinessJobs: [],
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
