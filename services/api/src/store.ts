import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';
import type { BrowserSession } from './sessions';
import {
  type AppState,
  type AuditEntry,
  type BookMeetingRequest,
  type BrokerDecision,
  type CalendarEvent,
  type CalendarPatch,
  type DeleteEventRequest,
  type EventKind,
  type MeetingReadinessJob,
  type PatchProposal,
  type PlanningIntent,
  type ReadinessStep,
  type ReadinessSuggestion,
  appStateSchema,
  createSeedState,
  demoUserId,
  evaluatePatch,
  id,
  makeEtag,
  nextEtag,
  primaryCalendarId,
  teamCalendarId,
} from './shared';

const { Pool } = pg;

export type StateListener = (state: AppState) => void;

type StoreMode = 'file' | 'postgres';

export class CalendarStore {
  readonly mode: StoreMode;
  readonly statePath: string | undefined;
  readonly postgresResourceName: string;
  #state: AppState | undefined;
  #pool: PgPool | undefined;
  #postgresConfig: ResolvedPostgresConfig | undefined;
  #databaseReady = false;
  #schemaReady = false;
  #loggedStore = false;
  #fileUpdateReady: Promise<void> = Promise.resolve();
  #listeners = new Set<StateListener>();

  constructor(stateDirectory = defaultStateDirectory()) {
    this.postgresResourceName = process.env.POSTGRES_RESOURCE_NAME ?? 'calendar';
    const postgresConfig = resolvePostgresConfig(this.postgresResourceName);
    const requestedStore = process.env.CALENDAR_STORE;

    if (requestedStore === 'postgres' || (!requestedStore && postgresConfig)) {
      if (!postgresConfig) {
        throw new Error(`CALENDAR_STORE=postgres but no PostgreSQL environment was found for "${this.postgresResourceName}".`);
      }
      this.mode = 'postgres';
      this.#postgresConfig = postgresConfig;
      this.#pool = new Pool(postgresConfig.config);
      this.statePath = undefined;
      this.logStore(`PostgreSQL "${this.postgresResourceName}" via ${postgresConfig.source} (${describePostgresConfig(postgresConfig.config)})`);
    } else if (requestedStore === undefined || requestedStore === 'file') {
      this.mode = 'file';
      this.statePath = path.join(stateDirectory, 'calendar-state.json');
      this.logStore(`file ${this.statePath}`);
    } else {
      throw new Error(`Unsupported CALENDAR_STORE value "${requestedStore}". Use "postgres" or "file".`);
    }
  }

  async load(): Promise<AppState> {
    if (this.#state) {
      return this.#state;
    }

    if (this.mode === 'postgres') {
      this.#state = await this.loadFromPostgres();
      return this.#state;
    }

    try {
      const raw = await readFile(must(this.statePath, 'File state path was not configured.'), 'utf8');
      this.#state = appStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFile(error)) {
        this.#state = createSeedState();
        await this.save();
      } else {
        throw error;
      }
    }

    return this.#state;
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async reset(): Promise<AppState> {
    const seed = createSeedState();

    if (this.mode === 'postgres') {
      await this.replacePostgresState(seed);
      this.#state = seed;
      this.publish(seed);
      return seed;
    }

    this.#state = seed;
    await this.saveAndPublish();
    return seed;
  }

  async generateBuildWeekCalendar(): Promise<AppState> {
    return this.update((state) => {
      const events = createBuildWeekEvents();
      state.events = events;
      clearTransientAgentState(state);
      state.audit = [
        audit('demo-command', 'generate-build-week-calendar', `Generated ${events.length} Build-themed calendar event(s).`),
      ];
    });
  }

  async clearCalendarEvents(): Promise<AppState> {
    return this.update((state) => {
      state.events = [];
      clearTransientAgentState(state);
      state.audit = [
        audit('demo-command', 'clear-calendar-events', 'Cleared all calendar events and agent state.'),
      ];
    });
  }

  async update(mutator: (state: AppState) => void): Promise<AppState> {
    if (this.mode === 'postgres') {
      return this.updatePostgres(mutator);
    }

    const previousUpdate = this.#fileUpdateReady;
    let releaseUpdate!: () => void;
    this.#fileUpdateReady = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    await previousUpdate;

    try {
      return await this.updateFile(mutator);
    } finally {
      releaseUpdate();
    }
  }

  private async updateFile(mutator: (state: AppState) => void): Promise<AppState> {
    const state = await this.load();
    mutator(state);
    state.version += 1;
    state.updatedAt = new Date().toISOString();
    await this.saveAndPublish();
    return state;
  }

  async createIntent(request: {
    userId: string;
    sessionId: string;
    source: 'drag' | 'command';
    eventId: string;
    desiredStart: string;
    desiredEnd: string;
  }): Promise<PlanningIntent> {
    let created: PlanningIntent | undefined;
    await this.update((state) => {
      const event = findEvent(state, request.eventId);
      if (!event) {
        throw new BrokerError(404, `Event ${request.eventId} was not found.`);
      }

      created = {
        id: id('intent'),
        userId: request.userId,
        sessionId: request.sessionId,
        source: request.source,
        eventId: request.eventId,
        desiredStart: request.desiredStart,
        desiredEnd: request.desiredEnd,
        etagAtIntent: event.etag,
        summary: `Move "${event.title}" to ${formatTime(request.desiredStart)}-${formatTime(request.desiredEnd)}`,
        createdAt: new Date().toISOString(),
        status: 'queued',
      };
      state.intents.unshift(created);
      state.lastDragIntentId = created.id;
      state.audit.unshift(audit('user', 'intent-created', created.summary, undefined, event.id));
    });

    return must(created, 'Intent was not created.');
  }

  async bookMeeting(request: BookMeetingRequest): Promise<{ event: CalendarEvent; decision: BrokerDecision; job: MeetingReadinessJob }> {
    let result: { event: CalendarEvent; decision: BrokerDecision; job: MeetingReadinessJob } | undefined;
    await this.update((state) => {
      const meetingId = id('meeting');
      const proposalId = id('proposal');
      const patch: CalendarPatch = {
        id: id('patch'),
        intentId: proposalId,
        operation: 'create',
        eventId: meetingId,
        changes: {
          title: request.title,
          kind: 'meeting',
          calendarId: primaryCalendarId,
          start: request.start,
          end: request.end,
          attendees: request.attendees,
          location: request.location,
          description: request.description,
        },
        reason: `Book "${request.title}" from the meeting creation form.`,
        confidence: 1,
      };
      const proposal: PatchProposal = {
        id: proposalId,
        intentId: proposalId,
        createdAt: new Date().toISOString(),
        createdBy: 'user',
        plannerMode: 'local',
        patches: [patch],
      };

      state.proposals.unshift(proposal);
      state.audit.unshift(audit('user', 'meeting-booking-submitted', `Submitted "${request.title}" to the broker for booking.`));
      const decision = evaluateAndMaybeApply(state, proposal, patch, true, {
        policy: 'user-booked-meeting',
        reason: 'User submitted the meeting booking form; broker validated and applied the create patch.',
      });
      const event = must(findEvent(state, meetingId), `Booked meeting ${meetingId} was not found after broker apply.`);
      const job = queueReadinessJob(state, {
        userId: request.userId,
        sessionId: request.sessionId,
        meetingId,
        createdBy: 'meeting-booking',
      }, event);

      result = {
        event: cloneEvent(event),
        decision: { ...decision },
        job: cloneReadinessJob(job),
      };
    });

    return must(result, 'Meeting was not booked.');
  }

  async requestDeleteEvent(eventId: string, request: DeleteEventRequest): Promise<BrokerDecision> {
    let requested: BrokerDecision | undefined;
    await this.update((state) => {
      const event = findEvent(state, eventId);
      if (!event) {
        throw new BrokerError(404, `Event ${eventId} was not found.`);
      }

      const proposalId = id('proposal');
      const patch: CalendarPatch = {
        id: id('patch'),
        intentId: proposalId,
        operation: 'delete',
        eventId: event.id,
        baseEtag: event.etag,
        changes: {},
        reason: `Delete "${event.title}" from the calendar.`,
        confidence: 1,
      };
      const proposal: PatchProposal = {
        id: proposalId,
        intentId: proposalId,
        createdAt: new Date().toISOString(),
        createdBy: 'user',
        plannerMode: 'local',
        patches: [patch],
      };

      state.proposals.unshift(proposal);
      state.audit.unshift(audit('user', 'delete-requested', `Requested deletion of "${event.title}".`, patch.id, event.id));
      requested = evaluateAndMaybeApply(state, proposal, patch, request.confirmed, request.confirmed
        ? {
          policy: 'user-confirmed-delete',
          reason: 'User confirmed the delete action in the calendar UI; broker validated and applied the delete patch.',
        }
        : undefined);
      if (requested.status === 'needs-confirmation') {
        state.audit.unshift(audit(
          'broker',
          'delete-confirmation-required',
          `Deletion of "${event.title}" is waiting for confirmation.`,
          patch.id,
          event.id,
        ));
      }
    });

    return must(requested, 'Delete request was not created.');
  }

  async claimNextIntent(workerId: string): Promise<{ intent: PlanningIntent; event: CalendarEvent } | undefined> {
    let claimed: { intent: PlanningIntent; event: CalendarEvent } | undefined;
    await this.update((state) => {
      const intent = state.intents.find((item) => item.status === 'queued');
      if (!intent) {
        return;
      }
      const event = findEvent(state, intent.eventId);
      if (!event) {
        intent.status = 'failed';
        state.audit.unshift(audit('broker', 'intent-failed', `Intent ${intent.id} references a missing event.`, undefined, intent.eventId));
        return;
      }
      intent.status = 'planning';
      state.audit.unshift(audit(workerId, 'intent-claimed', `Planner claimed ${intent.summary}`, undefined, event.id));
      claimed = { intent: { ...intent }, event: { ...event } };
    });
    return claimed;
  }

  async submitProposal(proposal: PatchProposal): Promise<BrokerDecision[]> {
    const decisions: BrokerDecision[] = [];

    await this.update((state) => {
      state.proposals.unshift(proposal);
      state.audit.unshift(audit(proposal.createdBy, 'proposal-submitted', `Submitted ${proposal.patches.length} calendar patch(es).`));

      for (const patch of proposal.patches) {
        const decision = evaluateAndMaybeApply(state, proposal, patch, false);
        decisions.push(decision);
      }

      const intent = state.intents.find((item) => item.id === proposal.intentId);
      if (intent) {
        intent.status = 'completed';
      }
    });

    return decisions;
  }

  async createReadinessJob(request: {
    userId: string;
    sessionId: string;
    meetingId: string;
    createdBy?: string;
  }): Promise<MeetingReadinessJob> {
    let created: MeetingReadinessJob | undefined;
    await this.update((state) => {
      const meeting = findEvent(state, request.meetingId);
      if (!meeting) {
        throw new BrokerError(404, `Meeting ${request.meetingId} was not found.`);
      }
      if (meeting.kind !== 'meeting') {
        throw new BrokerError(409, `"${meeting.title}" is a ${meeting.kind} block, not a meeting.`);
      }

      created = queueReadinessJob(state, request, meeting);
    });
    return must(created, 'Readiness job was not created.');
  }

  async claimNextReadinessJob(workerId: string): Promise<{ job: MeetingReadinessJob; meeting: CalendarEvent } | undefined> {
    let claimed: { job: MeetingReadinessJob; meeting: CalendarEvent } | undefined;
    await this.update((state) => {
      const job = state.readinessJobs.find((item) => item.status === 'queued');
      if (!job) {
        return;
      }

      const meeting = findEvent(state, job.meetingId);
      if (!meeting) {
        job.status = 'failed';
        job.error = `Meeting ${job.meetingId} no longer exists.`;
        job.currentStep = 'Meeting no longer exists.';
        job.updatedAt = new Date().toISOString();
        state.audit.unshift(audit('broker', 'readiness-failed', job.error, undefined, job.meetingId));
        return;
      }

      job.status = 'running';
      job.workerId = workerId;
      job.currentStep = 'Reading selected meeting details.';
      job.updatedAt = new Date().toISOString();
      state.audit.unshift(audit(workerId, 'readiness-claimed', `Meeting readiness agent claimed "${meeting.title}".`, undefined, meeting.id));
      claimed = { job: cloneReadinessJob(job), meeting: cloneEvent(meeting) };
    });
    return claimed;
  }

  async recordReadinessProgress(jobId: string, step: { stepId: string; label: string; detail: string }): Promise<MeetingReadinessJob> {
    let updated: MeetingReadinessJob | undefined;
    await this.update((state) => {
      const job = findReadinessJob(state, jobId);
      if (job.status === 'canceled') {
        updated = cloneReadinessJob(job);
        return;
      }
      if (job.status !== 'running') {
        throw new BrokerError(409, `Readiness job ${jobId} is ${job.status}, not running.`);
      }

      const completedAt = new Date().toISOString();
      const completedStep: ReadinessStep = { id: step.stepId, label: step.label, detail: step.detail, completedAt };
      const existingIndex = job.completedSteps.findIndex((item) => item.id === step.stepId);
      if (existingIndex === -1) {
        job.completedSteps.push(completedStep);
      } else {
        job.completedSteps[existingIndex] = completedStep;
      }
      job.currentStep = step.label;
      job.updatedAt = completedAt;
      updated = cloneReadinessJob(job);
      state.audit.unshift(audit(job.workerId ?? 'readiness-agent', 'readiness-progress', `${step.label}: ${step.detail}`, undefined, job.meetingId));
    });
    return must(updated, 'Readiness progress was not recorded.');
  }

  async completeReadinessJob(jobId: string, suggestions: ReadinessSuggestion[]): Promise<MeetingReadinessJob> {
    let completed: MeetingReadinessJob | undefined;
    await this.update((state) => {
      const job = findReadinessJob(state, jobId);
      if (job.status === 'canceled') {
        completed = cloneReadinessJob(job);
        return;
      }
      if (job.status !== 'running') {
        throw new BrokerError(409, `Readiness job ${jobId} is ${job.status}, not running.`);
      }

      job.status = 'completed';
      job.suggestions = suggestions;
      job.currentStep = 'Meeting readiness suggestions are ready.';
      job.updatedAt = new Date().toISOString();
      completed = cloneReadinessJob(job);
      state.audit.unshift(audit(job.workerId ?? 'readiness-agent', 'readiness-completed', `Returned ${suggestions.length} meeting readiness suggestion(s).`, undefined, job.meetingId));
    });
    return must(completed, 'Readiness job was not completed.');
  }

  async failReadinessJob(jobId: string, error: string): Promise<MeetingReadinessJob> {
    let failed: MeetingReadinessJob | undefined;
    await this.update((state) => {
      const job = findReadinessJob(state, jobId);
      if (job.status === 'canceled') {
        failed = cloneReadinessJob(job);
        return;
      }
      job.status = 'failed';
      job.error = error;
      job.currentStep = 'Meeting readiness analysis failed.';
      job.updatedAt = new Date().toISOString();
      failed = cloneReadinessJob(job);
      state.audit.unshift(audit(job.workerId ?? 'readiness-agent', 'readiness-failed', error, undefined, job.meetingId));
    });
    return must(failed, 'Readiness job was not failed.');
  }

  async acceptReadinessSuggestion(jobId: string, suggestionId: string): Promise<BrokerDecision> {
    let accepted: BrokerDecision | undefined;
    await this.update((state) => {
      const job = findReadinessJob(state, jobId);
      const suggestion = job.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion) {
        throw new BrokerError(404, `Suggestion ${suggestionId} was not found.`);
      }
      if (!suggestion.proposedPatch) {
        throw new BrokerError(409, `Suggestion ${suggestionId} does not include a calendar patch.`);
      }
      if (suggestion.decisionId) {
        throw new BrokerError(409, `Suggestion ${suggestionId} was already sent to the broker.`);
      }

      const patch: CalendarPatch = {
        ...suggestion.proposedPatch,
        intentId: job.id,
      };
      const proposal: PatchProposal = {
        id: id('proposal'),
        intentId: job.id,
        createdAt: new Date().toISOString(),
        createdBy: 'readiness-agent',
        plannerMode: 'local',
        patches: [patch],
      };

      state.proposals.unshift(proposal);
      state.audit.unshift(audit('readiness-agent', 'proposal-submitted', `Submitted accepted readiness suggestion "${suggestion.title}" to the broker.`));
      accepted = evaluateAndMaybeApply(state, proposal, patch, true, {
        policy: 'user-accepted-readiness-suggestion',
        reason: 'User accepted the readiness suggestion; broker re-validated and applied the calendar patch.',
      });
      suggestion.decisionId = accepted.id;
      job.updatedAt = new Date().toISOString();
    });
    return must(accepted, 'Readiness suggestion was not accepted.');
  }

  async confirmPatch(proposalId: string, patchId: string): Promise<BrokerDecision> {
    let confirmed: BrokerDecision | undefined;

    await this.update((state) => {
      const decision = state.decisions.find((item) => item.proposalId === proposalId && item.patchId === patchId);
      if (!decision) {
        throw new BrokerError(404, `Decision for patch ${patchId} was not found.`);
      }
      if (decision.status !== 'needs-confirmation') {
        throw new BrokerError(409, `Patch ${patchId} is ${decision.status}, not waiting for confirmation.`);
      }

      const proposal = state.proposals.find((item) => item.id === proposalId);
      const patch = proposal?.patches.find((item) => item.id === patchId);
      if (!proposal || !patch) {
        throw new BrokerError(404, `Patch ${patchId} was not found.`);
      }

      const event = patch.eventId ? findEvent(state, patch.eventId) : undefined;
      const evaluation = evaluatePatch(event, patch, state.userId);
      if (evaluation.kind === 'reject') {
        decision.status = 'rejected';
        decision.policy = evaluation.policy;
        decision.reason = evaluation.reason;
        decision.canConfirm = false;
        confirmed = { ...decision };
        state.audit.unshift(audit('broker', 'confirmation-rejected', evaluation.reason, patch.id, patch.eventId));
        return;
      }

      applyPatch(state, patch, 'user-confirmed');
      decision.status = 'applied';
      decision.policy = `${evaluation.policy}:confirmed`;
      decision.reason = 'User confirmed the agent proposal; broker applied it after re-validating policy and etag.';
      decision.canConfirm = false;
      confirmed = { ...decision };
      state.audit.unshift(audit('user', 'patch-confirmed', decision.reason, patch.id, patch.eventId));
    });

    return must(confirmed, 'Patch was not confirmed.');
  }

  async rejectPatch(proposalId: string, patchId: string): Promise<BrokerDecision> {
    let rejected: BrokerDecision | undefined;
    await this.update((state) => {
      const decision = state.decisions.find((item) => item.proposalId === proposalId && item.patchId === patchId);
      if (!decision) {
        throw new BrokerError(404, `Decision for patch ${patchId} was not found.`);
      }
      decision.status = 'rejected';
      decision.policy = 'user-rejected';
      decision.reason = 'User rejected the pending agent proposal.';
      decision.canConfirm = false;
      rejected = { ...decision };
      state.audit.unshift(audit('user', 'patch-rejected', decision.reason, patchId, decision.eventId));
    });
    return must(rejected, 'Patch was not rejected.');
  }

  async undoLastApplied(): Promise<AuditEntry | undefined> {
    let restored: AuditEntry | undefined;

    await this.update((state) => {
      const entry = state.audit.find((item) => item.previousEvent);
      if (!entry?.previousEvent) {
        return;
      }

      const index = state.events.findIndex((event) => event.id === entry.previousEvent?.id);
      if (index === -1) {
        state.events.push(entry.previousEvent);
      } else {
        state.events[index] = entry.previousEvent;
      }

      restored = audit('user', 'undo', `Restored "${entry.previousEvent.title}" to its previous calendar state.`, entry.patchId, entry.previousEvent.id);
      state.audit.unshift(restored);
    });

    return restored;
  }

  async clearPending(): Promise<number> {
    let count = 0;
    await this.update((state) => {
      for (const decision of state.decisions) {
        if (decision.status === 'needs-confirmation') {
          decision.status = 'rejected';
          decision.policy = 'demo-cleared';
          decision.reason = 'Pending proposal cleared by demo command.';
          decision.canConfirm = false;
          count += 1;
        }
      }
      state.audit.unshift(audit('demo-command', 'clear-pending', `Cleared ${count} pending proposal(s).`));
    });
    return count;
  }

  async triggerReplanning(): Promise<PlanningIntent> {
    const state = await this.load();
    const event = state.events.find((item) => item.id === 'task-1') ?? state.events[0];
    const start = new Date(event.start);
    start.setHours(16, 0, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 45);
    return this.createIntent({
      userId: state.userId,
      sessionId: state.sessionId,
      source: 'command',
      eventId: event.id,
      desiredStart: start.toISOString(),
      desiredEnd: end.toISOString(),
    });
  }

  async replayLastDrag(): Promise<PlanningIntent> {
    const state = await this.load();
    const lastIntent = state.intents.find((item) => item.id === state.lastDragIntentId) ?? state.intents[0];
    if (!lastIntent) {
      return this.triggerReplanning();
    }
    return this.createIntent({
      userId: lastIntent.userId,
      sessionId: lastIntent.sessionId,
      source: 'command',
      eventId: lastIntent.eventId,
      desiredStart: lastIntent.desiredStart,
      desiredEnd: lastIntent.desiredEnd,
    });
  }

  async simulateConflict(): Promise<BrokerDecision> {
    let staleDecision: BrokerDecision | undefined;

    await this.update((state) => {
      const event = state.events.find((item) => item.id === 'focus-1') ?? state.events[0];
      const staleEtag = event.etag;
      event.description = 'Edited by a human just before the planner response arrived.';
      event.etag = nextEtag(event.etag);

      const intent: PlanningIntent = {
        id: id('intent'),
        userId: state.userId,
        sessionId: state.sessionId,
        source: 'command',
        eventId: event.id,
        desiredStart: event.start,
        desiredEnd: event.end,
        etagAtIntent: staleEtag,
        summary: `Conflict demo for "${event.title}"`,
        createdAt: new Date().toISOString(),
        status: 'completed',
      };
      state.intents.unshift(intent);

      const patch: CalendarPatch = {
        id: id('patch'),
        intentId: intent.id,
        operation: 'move',
        eventId: event.id,
        baseEtag: staleEtag,
        changes: {
          start: event.start,
          end: event.end,
        },
        reason: 'Planner responded with a stale etag after a human edited the event.',
        confidence: 0.7,
      };
      const proposal: PatchProposal = {
        id: id('proposal'),
        intentId: intent.id,
        createdAt: new Date().toISOString(),
        createdBy: 'demo-conflict-agent',
        plannerMode: 'local',
        patches: [patch],
      };
      state.proposals.unshift(proposal);
      staleDecision = evaluateAndMaybeApply(state, proposal, patch, false);
      state.audit.unshift(audit('demo-command', 'simulate-conflict', 'Created a stale-etag proposal and let the broker reject it.', patch.id, event.id));
    });

    return must(staleDecision, 'Conflict decision was not created.');
  }

  async agentSessionSummary(session: BrowserSession): Promise<Record<string, unknown>> {
    const state = await this.load();
    const latestJob = state.readinessJobs.find((job) => job.sessionId === session.sessionId) ?? state.readinessJobs[0] ?? null;
    const hosted = state.proposals.find((proposal) => proposal.hostedAgentSession)?.hostedAgentSession;
    return {
      runtime: process.env.PLANNER_MODE === 'foundry-hosted'
        ? 'foundry-hosted'
        : process.env.PLANNER_MODE === 'copilot-sdk'
          ? 'copilot-sdk'
          : 'local',
      browserSession: session,
      latestReadinessJob: latestJob,
      hostedAgentSession: hosted ?? null,
      note: 'The browser has an HttpOnly cookie. The API maps it to this public session, and the worker keeps Foundry agent_session_id affinity server-side.',
    };
  }

  async triggerReadinessDemo(): Promise<MeetingReadinessJob> {
    const state = await this.load();
    const meeting = state.events.find((item) => item.id === 'meeting-demo-review' && item.kind === 'meeting')
      ?? state.events.find((item) => item.kind === 'meeting');
    if (!meeting) {
      throw new BrokerError(404, 'No meeting is available for readiness analysis.');
    }
    return this.createReadinessJob({
      userId: state.userId,
      sessionId: state.sessionId,
      meetingId: meeting.id,
      createdBy: 'demo-command',
    });
  }

  async getMeeting(meetingId: string): Promise<CalendarEvent> {
    const state = await this.load();
    const meeting = findEvent(state, meetingId);
    if (!meeting) {
      throw new BrokerError(404, `Meeting ${meetingId} was not found.`);
    }
    if (meeting.kind !== 'meeting') {
      throw new BrokerError(409, `"${meeting.title}" is a ${meeting.kind} block, not a meeting.`);
    }
    return cloneEvent(meeting);
  }

  async getCalendarWindow(meetingId: string, days = 7): Promise<{ start: string; end: string; events: CalendarEvent[] }> {
    const state = await this.load();
    const meeting = findEvent(state, meetingId);
    if (!meeting) {
      throw new BrokerError(404, `Meeting ${meetingId} was not found.`);
    }

    const start = startOfDay(addDays(new Date(meeting.start), -3));
    const end = addDays(start, days);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      events: state.events
        .filter((event) => overlaps(event.start, event.end, start.toISOString(), end.toISOString()))
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .map(cloneEvent),
    };
  }

  async getWeatherForMeeting(meetingId: string): Promise<Record<string, unknown>> {
    const meeting = await this.getMeeting(meetingId);
    return {
      meetingId,
      location: meeting.location ?? 'Seattle',
      forecastAt: meeting.start,
      condition: 'Light rain and cool wind',
      temperatureF: 58,
      precipitationChance: 72,
      recommendation: 'Bring a light rain jacket and umbrella; choose shoes that can handle wet sidewalks.',
    };
  }

  async getTravelPlanForMeeting(meetingId: string): Promise<Record<string, unknown>> {
    const state = await this.load();
    const meeting = findEvent(state, meetingId);
    if (!meeting) {
      throw new BrokerError(404, `Meeting ${meetingId} was not found.`);
    }

    const meetingStart = Date.parse(meeting.start);
    const previous = state.events
      .filter((event) => event.id !== meeting.id && dateKey(event.end) === dateKey(meeting.start) && Date.parse(event.end) <= meetingStart)
      .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
    const travelMinutes = meeting.location?.toLowerCase().includes('seattle') ? 25 : 10;
    const leaveAt = new Date(meetingStart - travelMinutes * 60000);

    return {
      meetingId,
      from: previous?.location ?? 'desk',
      to: meeting.location ?? 'meeting location',
      previousEvent: previous ? { id: previous.id, title: previous.title, end: previous.end } : null,
      travelMinutes,
      leaveAt: leaveAt.toISOString(),
      recommendation: previous
        ? `Leave ${travelMinutes} minutes after "${previous.title}" ends if you are going in person.`
        : `Hold ${travelMinutes} minutes before the meeting for travel or setup.`,
    };
  }

  async getMeetingMaterials(meetingId: string): Promise<Record<string, unknown>> {
    const meeting = await this.getMeeting(meetingId);
    const hasAgenda = Boolean(meeting.description?.toLowerCase().includes('review'));
    return {
      meetingId,
      topic: meeting.title,
      agendaStatus: hasAgenda ? 'agenda-present' : 'agenda-missing',
      checklist: [
        'Demo script with the meeting-readiness story',
        'Aspire dashboard ready on the AppHost resource graph',
        'Fallback talking track for broker policy and hosted-agent isolation',
      ],
      openQuestions: [
        'Which readiness card should be accepted live?',
        'Should weather/travel stay informational or become calendar blocks?',
      ],
    };
  }

  private async saveAndPublish(): Promise<void> {
    await this.save();
    const state = await this.load();
    this.publish(state);
  }

  private async save(): Promise<void> {
    if (this.mode === 'postgres') {
      await this.replacePostgresState(must(this.#state, 'State was not loaded.'));
      return;
    }

    const state = must(this.#state, 'State was not loaded.');
    const statePath = must(this.statePath, 'File state path was not configured.');
    await mkdir(path.dirname(statePath), { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, statePath);
  }

  private async loadFromPostgres(): Promise<AppState> {
    const client = await this.connectPostgres();
    try {
      await this.ensurePostgresSchema(client);
      const result = await client.query<{ data: unknown }>(
        'SELECT data FROM calendar_app_state WHERE id = $1',
        [singletonStateId],
      );

      if (result.rowCount === 0) {
        const seed = createSeedState();
        console.log('[broker] No calendar state found; seeding default demo calendar state.');
        await client.query(
          'INSERT INTO calendar_app_state (id, data, updated_at) VALUES ($1, $2::jsonb, now())',
          [singletonStateId, JSON.stringify(seed)],
        );
        return seed;
      }

      return appStateSchema.parse(result.rows[0].data);
    } finally {
      client.release();
    }
  }

  private async updatePostgres(mutator: (state: AppState) => void): Promise<AppState> {
    const client = await this.connectPostgres();
    try {
      await client.query('BEGIN');
      await this.ensurePostgresSchema(client);
      const state = await this.loadLockedPostgresState(client);
      mutator(state);
      state.version += 1;
      state.updatedAt = new Date().toISOString();
      const next = appStateSchema.parse(state);
      await client.query(
        'UPDATE calendar_app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1',
        [singletonStateId, JSON.stringify(next)],
      );
      await client.query('COMMIT');
      this.#state = next;
      this.publish(next);
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadLockedPostgresState(client: PoolClient): Promise<AppState> {
    const result = await client.query<{ data: unknown }>(
      'SELECT data FROM calendar_app_state WHERE id = $1 FOR UPDATE',
      [singletonStateId],
    );

    if (result.rowCount === 0) {
      const seed = createSeedState();
      await client.query(
        'INSERT INTO calendar_app_state (id, data, updated_at) VALUES ($1, $2::jsonb, now())',
        [singletonStateId, JSON.stringify(seed)],
      );
      return seed;
    }

    return appStateSchema.parse(result.rows[0].data);
  }

  private async replacePostgresState(state: AppState): Promise<void> {
    const client = await this.connectPostgres();
    try {
      await client.query('BEGIN');
      await this.ensurePostgresSchema(client);
      await client.query(
        `INSERT INTO calendar_app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [singletonStateId, JSON.stringify(appStateSchema.parse(state))],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensurePostgresSchema(client: PoolClient): Promise<void> {
    if (this.#schemaReady) {
      return;
    }

    console.log('[broker] Ensuring PostgreSQL schema "calendar_app_state" exists.');
    await client.query(`
      CREATE TABLE IF NOT EXISTS calendar_app_state (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    this.#schemaReady = true;
    console.log('[broker] PostgreSQL schema is ready.');
  }

  private async connectPostgres(): Promise<PoolClient> {
    const pool = must(this.#pool, 'PostgreSQL pool was not configured.');
    const attempts = postgresConnectAttempts();

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.ensurePostgresDatabase();
        const client = await pool.connect();
        if (attempt > 1) {
          console.log(`[broker] PostgreSQL connection succeeded on attempt ${attempt}.`);
        }
        return client;
      } catch (error) {
        if (!isTransientPostgresStartupError(error) || attempt === attempts) {
          console.error(`[broker] PostgreSQL connection failed on attempt ${attempt}/${attempts}.`, error);
          throw error;
        }

        const delayMs = postgresRetryDelayMs(attempt);
        console.warn(
          `[broker] PostgreSQL is not ready yet (${describePostgresError(error)}). Retrying in ${delayMs}ms (${attempt}/${attempts}).`,
        );
        await delay(delayMs);
      }
    }

    throw new Error('PostgreSQL connection retry loop exited unexpectedly.');
  }

  private async ensurePostgresDatabase(): Promise<void> {
    if (this.#databaseReady) {
      return;
    }

    const resolved = must(this.#postgresConfig, 'PostgreSQL config was not resolved.');
    const database = postgresDatabaseName(resolved.config);
    const maintenanceDatabase = process.env.POSTGRES_MAINTENANCE_DATABASE ?? process.env.CALENDAR_MAINTENANCE_DATABASE ?? 'postgres';

    if (database === maintenanceDatabase) {
      this.#databaseReady = true;
      return;
    }

    console.log(`[broker] Ensuring PostgreSQL database "${database}" exists via maintenance database "${maintenanceDatabase}".`);
    const maintenancePool = new Pool({ ...resolved.config, database: maintenanceDatabase });

    try {
      const client = await maintenancePool.connect();
      try {
        const result = await client.query<{ exists: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
          [database],
        );

        if (result.rows[0]?.exists) {
          console.log(`[broker] PostgreSQL database "${database}" already exists.`);
        } else {
          console.log(`[broker] Creating PostgreSQL database "${database}".`);
          await client.query(`CREATE DATABASE ${quotePostgresIdentifier(database)}`);
          console.log(`[broker] PostgreSQL database "${database}" created.`);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      if (postgresErrorCode(error) === '42P04') {
        console.log(`[broker] PostgreSQL database "${database}" was created by another startup attempt.`);
      } else {
        if (!isTransientPostgresStartupError(error)) {
          console.error(`[broker] Failed to ensure PostgreSQL database "${database}" exists.`, error);
        }
        throw error;
      }
    } finally {
      await maintenancePool.end();
    }

    this.#databaseReady = true;
  }

  private publish(state: AppState): void {
    for (const listener of this.#listeners) {
      listener(state);
    }
  }

  private logStore(message: string): void {
    if (this.#loggedStore) {
      return;
    }
    this.#loggedStore = true;
    console.log(`[broker] Calendar state store: ${message}`);
  }
}

export class BrokerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function evaluateAndMaybeApply(
  state: AppState,
  proposal: PatchProposal,
  patch: CalendarPatch,
  confirmed: boolean,
  appliedOverride?: { policy: string; reason: string },
): BrokerDecision {
  const event = patch.eventId ? findEvent(state, patch.eventId) : undefined;
  const evaluation = evaluatePatch(event, patch, state.userId);
  const status: BrokerDecision['status'] =
    evaluation.kind === 'reject' ? 'rejected' : evaluation.kind === 'auto-apply' || confirmed ? 'applied' : 'needs-confirmation';
  const policy = status === 'applied' && appliedOverride ? appliedOverride.policy : evaluation.policy;
  const reason = status === 'applied' && appliedOverride ? appliedOverride.reason : evaluation.reason;

  if (status === 'applied') {
    applyPatch(state, patch, proposal.createdBy);
  }

  const decision: BrokerDecision = {
    id: id('decision'),
    proposalId: proposal.id,
    patchId: patch.id,
    intentId: proposal.intentId,
    eventId: patch.eventId,
    status,
    policy,
    reason,
    createdAt: new Date().toISOString(),
    canConfirm: status === 'needs-confirmation' && evaluation.canConfirm,
  };
  state.decisions.unshift(decision);
  state.audit.unshift(audit('broker', `patch-${status}`, `${decision.policy}: ${decision.reason}`, patch.id, patch.eventId));
  return decision;
}

function applyPatch(state: AppState, patch: CalendarPatch, actor: string): void {
  if (patch.operation === 'create') {
    const eventId = patch.eventId ?? id('event');
    const created: CalendarEvent = {
      id: eventId,
      calendarId: patch.changes.calendarId ?? primaryCalendarId,
      ownerId: state.userId,
      title: patch.changes.title ?? 'New planned block',
      kind: patch.changes.kind ?? 'draft',
      start: must(patch.changes.start, 'Create patch requires start.'),
      end: must(patch.changes.end, 'Create patch requires end.'),
      etag: makeEtag(eventId, 1),
      attendees: patch.changes.attendees ?? [],
      location: patch.changes.location,
      description: patch.changes.description,
    };
    state.events.push(created);
    state.audit.unshift(audit(actor, 'patch-applied', `Created "${created.title}".`, patch.id, created.id));
    return;
  }

  const index = state.events.findIndex((event) => event.id === patch.eventId);
  if (index === -1) {
    throw new BrokerError(404, `Event ${patch.eventId} was not found.`);
  }

  const previousEvent = { ...state.events[index], attendees: [...state.events[index].attendees] };

  if (patch.operation === 'delete') {
    state.events.splice(index, 1);
    cancelReadinessJobsForMeeting(state, previousEvent);
    state.audit.unshift(audit(actor, 'patch-applied', `Deleted "${previousEvent.title}".`, patch.id, previousEvent.id, previousEvent));
    return;
  }

  state.events[index] = {
    ...state.events[index],
    ...patch.changes,
    attendees: patch.changes.attendees ?? state.events[index].attendees,
    etag: nextEtag(state.events[index].etag),
  };
  state.audit.unshift(audit(actor, 'patch-applied', `Updated "${state.events[index].title}".`, patch.id, state.events[index].id, previousEvent));
}

function cancelReadinessJobsForMeeting(state: AppState, meeting: CalendarEvent): void {
  const now = new Date().toISOString();
  let canceledCount = 0;
  for (const job of state.readinessJobs) {
    if (job.meetingId !== meeting.id || !['queued', 'running'].includes(job.status)) {
      continue;
    }
    job.status = 'canceled';
    job.currentStep = 'Meeting was deleted before readiness analysis finished.';
    job.updatedAt = now;
    delete job.error;
    canceledCount += 1;
  }

  if (canceledCount > 0) {
    state.audit.unshift(audit(
      'broker',
      'readiness-canceled',
      `Canceled ${canceledCount} readiness job${canceledCount === 1 ? '' : 's'} for deleted meeting "${meeting.title}".`,
      undefined,
      meeting.id,
    ));
  }
}

function createBuildWeekEvents(now = new Date('2026-06-02T09:00:00-07:00')): CalendarEvent[] {
  const weekStart = startOfDay(now);
  const events: CalendarEvent[] = [];
  const occupied = new Map<number, Array<{ start: string; end: string }>>();
  const add = (dayOffset: number, hour: number, minute: number, durationMinutes: number, draft: CalendarEventDraft, eventId?: string) => {
    const start = at(weekStart, dayOffset, hour, minute);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    if (hasOverlap(occupied.get(dayOffset) ?? [], start.toISOString(), end.toISOString())) {
      return false;
    }

    const idPart = eventId ?? id(`event-${dayOffset}`);
    events.push({
      id: idPart,
      calendarId: draft.calendarId ?? primaryCalendarId,
      ownerId: draft.ownerId ?? demoUserId,
      title: draft.title,
      kind: draft.kind,
      start: start.toISOString(),
      end: end.toISOString(),
      etag: makeEtag(idPart, 1),
      attendees: draft.attendees ?? [],
      location: draft.location,
      description: draft.description,
    });
    occupied.set(dayOffset, [...(occupied.get(dayOffset) ?? []), { start: start.toISOString(), end: end.toISOString() }]);
    return true;
  };

  add(0, 8, 30, 45, {
    title: 'Badge pickup and speaker check-in',
    kind: 'task',
    location: 'Convention center lobby',
  }, 'task-badge-pickup');
  add(0, 11, 0, 60, {
    title: 'Build keynote sync',
    kind: 'meeting',
    attendees: ['nikki@example.com', 'scott@example.com'],
    location: 'Teams',
    description: 'Confirm keynote timing, demo handoff, and fallback plan.',
  }, 'meeting-1');
  add(3, 15, 0, 60, {
    title: 'Build 2026 demo readiness review',
    kind: 'meeting',
    attendees: ['nikki@example.com', 'scott@example.com', 'maya@example.com'],
    location: 'Microsoft Reactor - Seattle',
    description: 'Review the Aspire agent demo story, readiness cards, and broker safety boundary.',
  }, 'meeting-demo-review');
  add(3, 13, 0, 60, {
    title: 'Shared booth coverage',
    kind: 'team',
    calendarId: teamCalendarId,
    ownerId: 'team-build',
    attendees: ['team@example.com'],
    location: 'Expo hall',
  }, 'team-1');

  const usedTitles = new Set(events.map((event) => event.title));
  const slots: Array<[number, number]> = [
    [8, 30],
    [9, 0],
    [10, 0],
    [11, 0],
    [13, 0],
    [14, 0],
    [15, 0],
    [16, 0],
  ];

  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const targetCount = dayOffset >= 5 ? randomInt(1, 3) : randomInt(3, 6);
    const shuffledSlots = shuffle(slots);
    for (const [hour, minute] of shuffledSlots) {
      const currentCount = events.filter((event) => dateKey(event.start) === dateKey(at(weekStart, dayOffset, 0, 0).toISOString())).length;
      if (currentCount >= targetCount) {
        break;
      }

      const draft = randomBuildEventDraft(dayOffset, usedTitles);
      if (add(dayOffset, hour, minute, draft.durationMinutes, draft)) {
        usedTitles.add(draft.title);
      }
    }
  }

  return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function clearTransientAgentState(state: AppState): void {
  state.intents = [];
  state.proposals = [];
  state.decisions = [];
  state.readinessJobs = [];
  state.lastDragIntentId = undefined;
}

type BuildEventDraft = {
  title: string;
  kind: EventKind;
  durationMinutes: number;
  calendarId?: string;
  ownerId?: string;
  attendees?: string[];
  location?: string;
  description?: string;
};

type CalendarEventDraft = Omit<BuildEventDraft, 'durationMinutes'>;

function randomBuildEventDraft(dayOffset: number, usedTitles: Set<string>): BuildEventDraft {
  const pool = daySpecificBuildEvents[dayOffset] ?? weekdayBuildEvents;
  const available = pool.filter((event) => !usedTitles.has(event.title));
  if (available.length === 0) {
    const fallback = fallbackBuildEvents.filter((event) => !usedTitles.has(event.title));
    return {
      ...pick(fallback.length > 0 ? fallback : fallbackBuildEvents),
    };
  }
  return { ...pick(available) };
}

const daySpecificBuildEvents: Record<number, BuildEventDraft[]> = {
  0: [
    {
      title: 'Keynote rehearsal notes',
      kind: 'draft',
      durationMinutes: 30,
      location: 'Speaker room',
    },
    {
      title: 'Build keynote watch block',
      kind: 'meeting',
      durationMinutes: 60,
      attendees: ['nikki@example.com', 'scott@example.com'],
      location: 'Teams',
    },
    {
      title: 'Expo booth setup',
      kind: 'team',
      durationMinutes: 60,
      calendarId: teamCalendarId,
      ownerId: 'team-build',
      attendees: ['team@example.com'],
      location: 'Expo hall',
    },
    {
      title: 'Review opening demo checklist',
      kind: 'focus',
      durationMinutes: 45,
      location: 'Speaker room',
    },
  ],
  1: [
    {
      title: 'Customer hallway follow-up',
      kind: 'meeting',
      durationMinutes: 45,
      attendees: ['customer@example.com', 'maya@example.com'],
      location: 'Conference room 4B',
    },
    {
      title: 'Polish hosted-agent talking points',
      kind: 'focus',
      durationMinutes: 60,
      location: 'Desk',
    },
    {
      title: 'Partner demo prep',
      kind: 'prep',
      durationMinutes: 45,
      location: 'Speaker room',
    },
    {
      title: 'Capture keynote action items',
      kind: 'draft',
      durationMinutes: 30,
      location: 'Desk',
    },
  ],
  2: [
    {
      title: 'Agent safety story review',
      kind: 'meeting',
      durationMinutes: 45,
      attendees: ['sarah@example.com', 'nikki@example.com'],
      location: 'Teams',
      description: 'Review broker authority, confirmation policy, and hosted-agent boundaries.',
    },
    {
      title: 'Dry-run resource commands',
      kind: 'focus',
      durationMinutes: 60,
      location: 'Speaker room',
    },
    {
      title: 'Booth Q&A rotation',
      kind: 'team',
      durationMinutes: 60,
      calendarId: teamCalendarId,
      ownerId: 'team-build',
      attendees: ['team@example.com'],
      location: 'Expo hall',
    },
    {
      title: 'Lunch and hallway buffer',
      kind: 'task',
      durationMinutes: 45,
      location: 'Conference center',
    },
  ],
  3: [
    {
      title: 'Final demo environment check',
      kind: 'focus',
      durationMinutes: 60,
      location: 'Speaker room',
    },
    {
      title: 'Customer feedback readout',
      kind: 'meeting',
      durationMinutes: 45,
      attendees: ['maya@example.com', 'customer@example.com'],
      location: 'Teams',
    },
    {
      title: 'Update demo script',
      kind: 'draft',
      durationMinutes: 45,
      location: 'Desk',
    },
  ],
  4: [
    {
      title: 'Office hours: Aspire app model',
      kind: 'team',
      durationMinutes: 60,
      calendarId: teamCalendarId,
      ownerId: 'team-build',
      attendees: ['team@example.com'],
      location: 'Expo hall',
    },
    {
      title: 'File bugs from rehearsal',
      kind: 'task',
      durationMinutes: 45,
      location: 'Desk',
    },
    {
      title: 'Write Build recap draft',
      kind: 'draft',
      durationMinutes: 45,
      location: 'Hotel lobby',
    },
  ],
  5: [
    {
      title: 'Pack demo kit',
      kind: 'task',
      durationMinutes: 45,
      location: 'Hotel',
    },
    {
      title: 'Review speaker notes',
      kind: 'focus',
      durationMinutes: 60,
      location: 'Hotel',
    },
    {
      title: 'Team dinner logistics',
      kind: 'team',
      durationMinutes: 60,
      calendarId: teamCalendarId,
      ownerId: 'team-build',
      attendees: ['team@example.com'],
      location: 'Restaurant',
    },
  ],
  6: [
    {
      title: 'Send Build week recap',
      kind: 'draft',
      durationMinutes: 30,
      location: 'Desk',
    },
    {
      title: 'Expense receipts',
      kind: 'task',
      durationMinutes: 30,
      location: 'Hotel',
    },
    {
      title: 'Fly home',
      kind: 'prep',
      durationMinutes: 60,
      location: 'Airport',
    },
  ],
};

const weekdayBuildEvents: BuildEventDraft[] = [
  {
    title: 'Rehearse Aspire dashboard reveal',
    kind: 'focus',
    durationMinutes: 60,
    location: 'Speaker room',
  },
  {
    title: 'Polish meeting readiness cards',
    kind: 'task',
    durationMinutes: 45,
    location: 'Desk',
  },
  {
    title: 'Agent safety story review',
    kind: 'meeting',
    durationMinutes: 45,
    attendees: ['sarah@example.com', 'nikki@example.com'],
    location: 'Teams',
    description: 'Review broker authority, confirmation policy, and hosted-agent boundaries.',
  },
  {
    title: 'Partner briefing: cloud-native agents',
    kind: 'meeting',
    durationMinutes: 60,
    attendees: ['partner@example.com', 'scott@example.com'],
    location: 'Conference room 4B',
  },
  {
    title: 'Test ACA deployment path',
    kind: 'task',
    durationMinutes: 60,
    location: 'Desk',
  },
  {
    title: 'Customer feedback readout',
    kind: 'meeting',
    durationMinutes: 45,
    attendees: ['maya@example.com', 'customer@example.com'],
    location: 'Teams',
  },
  {
    title: 'Booth Q&A rotation',
    kind: 'team',
    durationMinutes: 60,
    calendarId: teamCalendarId,
    ownerId: 'team-build',
    attendees: ['team@example.com'],
    location: 'Expo hall',
  },
  {
    title: 'Update demo script',
    kind: 'draft',
    durationMinutes: 45,
    location: 'Desk',
  },
  {
    title: 'Office hours: Aspire app model',
    kind: 'team',
    durationMinutes: 60,
    calendarId: teamCalendarId,
    ownerId: 'team-build',
    attendees: ['team@example.com'],
    location: 'Expo hall',
  },
  {
    title: 'Lunch and hallway buffer',
    kind: 'task',
    durationMinutes: 45,
    location: 'Conference center',
  },
  {
    title: 'Record follow-up notes',
    kind: 'draft',
    durationMinutes: 30,
    location: 'Hotel lobby',
  },
  {
    title: 'Dry-run resource commands',
    kind: 'focus',
    durationMinutes: 60,
    location: 'Speaker room',
  },
];

const fallbackBuildEvents: BuildEventDraft[] = [
  {
    title: 'Pack demo kit',
    kind: 'task',
    durationMinutes: 45,
    location: 'Hotel',
  },
  {
    title: 'Venue-to-hotel travel buffer',
    kind: 'prep',
    durationMinutes: 45,
    location: 'Hotel lobby',
  },
  {
    title: 'Review speaker notes',
    kind: 'focus',
    durationMinutes: 60,
    location: 'Hotel',
  },
  {
    title: 'Send Build week recap',
    kind: 'draft',
    durationMinutes: 30,
    location: 'Desk',
  },
  {
    title: 'Team dinner logistics',
    kind: 'team',
    durationMinutes: 60,
    calendarId: teamCalendarId,
    ownerId: 'team-build',
    attendees: ['team@example.com'],
    location: 'Restaurant',
  },
];

function audit(
  actor: string,
  action: string,
  message: string,
  patchId?: string,
  eventId?: string,
  previousEvent?: CalendarEvent,
): AuditEntry {
  return {
    id: id('audit'),
    at: new Date().toISOString(),
    actor,
    action,
    message,
    patchId,
    eventId,
    previousEvent,
  };
}

function findEvent(state: AppState, eventId: string): CalendarEvent | undefined {
  return state.events.find((event) => event.id === eventId);
}

function findReadinessJob(state: AppState, jobId: string): MeetingReadinessJob {
  const job = state.readinessJobs.find((item) => item.id === jobId);
  if (!job) {
    throw new BrokerError(404, `Readiness job ${jobId} was not found.`);
  }
  return job;
}

function queueReadinessJob(
  state: AppState,
  request: {
    userId: string;
    sessionId: string;
    meetingId: string;
    createdBy?: string;
  },
  meeting: CalendarEvent,
): MeetingReadinessJob {
  const now = new Date().toISOString();
  const created: MeetingReadinessJob = {
    id: id('readiness'),
    userId: request.userId,
    sessionId: request.sessionId,
    meetingId: request.meetingId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    createdBy: request.createdBy ?? 'user',
    currentStep: 'Queued for meeting readiness agent.',
    completedSteps: [],
    suggestions: [],
  };
  state.readinessJobs.unshift(created);
  state.audit.unshift(audit(
    request.createdBy ?? 'user',
    'readiness-queued',
    `Queued meeting readiness analysis for "${meeting.title}".`,
    undefined,
    meeting.id,
  ));
  return created;
}

function cloneEvent(event: CalendarEvent): CalendarEvent {
  return {
    ...event,
    attendees: [...event.attendees],
  };
}

function cloneReadinessJob(job: MeetingReadinessJob): MeetingReadinessJob {
  return {
    ...job,
    completedSteps: job.completedSteps.map((step) => ({ ...step })),
    suggestions: job.suggestions.map((suggestion) => ({
      ...suggestion,
      proposedPatch: suggestion.proposedPatch
        ? {
            ...suggestion.proposedPatch,
            changes: {
              ...suggestion.proposedPatch.changes,
              attendees: suggestion.proposedPatch.changes.attendees ? [...suggestion.proposedPatch.changes.attendees] : undefined,
            },
          }
        : undefined,
    })),
  };
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

function overlaps(eventStart: string, eventEnd: string, windowStart: string, windowEnd: string): boolean {
  return Date.parse(eventStart) < Date.parse(windowEnd) && Date.parse(eventEnd) > Date.parse(windowStart);
}

function hasOverlap(events: Array<{ start: string; end: string }>, start: string, end: string): boolean {
  return events.some((event) => overlaps(event.start, event.end, start, end));
}

function at(day: Date, dayOffset: number, hour: number, minute: number): Date {
  const date = addDays(day, dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)];
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function dateKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function defaultStateDirectory(): string {
  return process.env.CALENDAR_STATE_DIR ?? path.resolve(process.cwd(), '../../.demo-state');
}

const singletonStateId = 'default';

type ResolvedPostgresConfig = {
  config: PoolConfig;
  source: string;
};

function resolvePostgresConfig(resourceName: string): ResolvedPostgresConfig | undefined {
  const prefix = envPrefix(resourceName);
  const host = firstEnv(`${prefix}_HOST`, 'PGHOST');
  const database = firstEnv(`${prefix}_DATABASENAME`, `${prefix}_DATABASE`, 'PGDATABASE');
  const user = firstEnv(`${prefix}_USERNAME`, `${prefix}_USER`, 'PGUSER');
  const password = firstEnv(`${prefix}_PASSWORD`, 'PGPASSWORD');
  const port = firstEnv(`${prefix}_PORT`, 'PGPORT');

  if (host || database || user || password || port) {
    if (!host || !database || !user || !port) {
      throw new Error(
        `Incomplete PostgreSQL environment for "${resourceName}". Expected ${prefix}_HOST, ${prefix}_PORT, ${prefix}_USERNAME, ${prefix}_PASSWORD, and ${prefix}_DATABASENAME.`,
      );
    }

    return {
      config: {
        host,
        database,
        user,
        password,
        port: Number(port),
      },
      source: `${prefix}_*`,
    };
  }

  return undefined;
}

function describePostgresConfig(config: PoolConfig): string {
  return `host=${config.host ?? '(default)'} port=${config.port ?? '(default)'} database=${config.database ?? '(default)'} user=${config.user ?? '(default)'}`;
}

function envPrefix(resourceName: string): string {
  return resourceName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
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

function postgresDatabaseName(config: PoolConfig): string {
  return must(config.database, 'PostgreSQL database was not configured.');
}

function postgresConnectAttempts(): number {
  const configured = Number(process.env.CALENDAR_POSTGRES_CONNECT_ATTEMPTS ?? 60);
  return Number.isInteger(configured) && configured > 0 ? configured : 60;
}

function postgresRetryDelayMs(attempt: number): number {
  return Math.min(5000, 500 * 2 ** Math.min(attempt - 1, 4));
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isTransientPostgresStartupError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return (
    code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENOTFOUND'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN'
    || code === '57P03'
    || code === '53300'
    || code === '08000'
    || code === '08001'
    || code === '08006'
  );
}

function describePostgresError(error: unknown): string {
  const code = postgresErrorCode(error);
  if (code) {
    return `code ${code}`;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
