import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';
import {
  type AppState,
  type AuditEntry,
  type BrokerDecision,
  type CalendarEvent,
  type CalendarPatch,
  type PatchProposal,
  type PlanningIntent,
  appStateSchema,
  createSeedState,
  demoSessionId,
  demoUserId,
  evaluatePatch,
  id,
  makeEtag,
  nextEtag,
  primaryCalendarId,
} from '@build2026/shared';

const { Pool } = pg;

export type StateListener = (state: AppState) => void;

type StoreMode = 'file' | 'postgres';

export class CalendarStore {
  readonly mode: StoreMode;
  readonly statePath: string | undefined;
  readonly postgresResourceName: string;
  #state: AppState | undefined;
  #pool: PgPool | undefined;
  #schemaReady = false;
  #loggedStore = false;
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
      this.#pool = new Pool(postgresConfig.config);
      this.statePath = undefined;
      this.logStore(`PostgreSQL "${this.postgresResourceName}" via ${postgresConfig.source}`);
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

  async update(mutator: (state: AppState) => void): Promise<AppState> {
    if (this.mode === 'postgres') {
      return this.updatePostgres(mutator);
    }

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

  async agentSessionSummary(): Promise<Record<string, unknown>> {
    const state = await this.load();
    const hosted = state.proposals.find((proposal) => proposal.hostedAgentSession)?.hostedAgentSession;
    return {
      runtime: process.env.PLANNER_MODE === 'foundry-hosted' ? 'foundry-hosted' : 'local',
      userIsolationKey: process.env.FOUNDRY_USER_ISOLATION_KEY ?? demoUserId,
      chatIsolationKey: process.env.FOUNDRY_CHAT_ISOLATION_KEY ?? demoSessionId,
      hostedAgentSession: hosted ?? null,
      note: 'Isolation keys partition hosted-agent resources. The broker still owns calendar authorization.',
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS calendar_app_state (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    this.#schemaReady = true;
  }

  private async connectPostgres(): Promise<PoolClient> {
    const pool = must(this.#pool, 'PostgreSQL pool was not configured.');
    return pool.connect();
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

function evaluateAndMaybeApply(state: AppState, proposal: PatchProposal, patch: CalendarPatch, confirmed: boolean): BrokerDecision {
  const event = patch.eventId ? findEvent(state, patch.eventId) : undefined;
  const evaluation = evaluatePatch(event, patch, state.userId);
  const status: BrokerDecision['status'] =
    evaluation.kind === 'auto-apply' || confirmed ? 'applied' : evaluation.kind === 'confirm' ? 'needs-confirmation' : 'rejected';

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
    policy: evaluation.policy,
    reason: evaluation.reason,
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
      kind: 'draft',
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

  const uri = firstEnvEntry(`${prefix}_URI`, 'DATABASE_URL', 'POSTGRES_URL');
  return uri ? { config: { connectionString: uri.value }, source: uri.name } : undefined;
}

function envPrefix(resourceName: string): string {
  return resourceName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
}

function firstEnv(...names: string[]): string | undefined {
  return firstEnvEntry(...names)?.value;
}

function firstEnvEntry(...names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return { name, value };
    }
  }
  return undefined;
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
