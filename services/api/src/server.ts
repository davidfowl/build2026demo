import './otel';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import {
  bookMeetingRequestSchema,
  createReadinessJobRequestSchema,
  createIntentRequestSchema,
  deleteEventRequestSchema,
  proposalSchema,
  readinessFailureRequestSchema,
  readinessProgressRequestSchema,
  readinessResultRequestSchema,
  submitProposalRequestSchema,
  weatherReportSchema,
} from './shared';
import { getOrCreateBrowserSession, resetBrowserSession } from './sessions';
import { BrokerError, CalendarStore } from './store';

const port = Number(process.env.PORT ?? 4310);
const weatherBaseUrl = process.env.WEATHER_BASE_URL;
const store = new CalendarStore();
const app = express();
let ready = false;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'calendar-broker' });
});

app.get('/readiness', (_request, response) => {
  if (!ready) {
    response.status(503).json({ status: 'starting', service: 'calendar-broker' });
    return;
  }

  response.json({ status: 'ready', service: 'calendar-broker' });
});

app.get('/liveness', (_request, response) => {
  response.json({ status: 'alive', service: 'calendar-broker' });
});

app.get('/api/session', (request, response) => {
  response.json(getOrCreateBrowserSession(request, response));
});

app.post('/api/session/reset', (request, response) => {
  response.json(resetBrowserSession(request, response));
});

app.get('/api/state', async (request, response) => {
  getOrCreateBrowserSession(request, response);
  response.json(await store.load());
});

app.get('/api/stream', async (request, response) => {
  getOrCreateBrowserSession(request, response);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const send = (payload: unknown) => {
    response.write(`event: state\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send(await store.load());
  const unsubscribe = store.subscribe(send);
  request.on('close', unsubscribe);
});

app.post('/api/intents', async (request, response) => {
  const body = createIntentRequestSchema.parse(request.body);
  const session = getOrCreateBrowserSession(request, response);
  const intent = await store.createIntent({ ...body, userId: session.userId, sessionId: session.sessionId });
  response.status(202).json({ intent });
});

app.post('/api/meetings', async (request, response) => {
  const body = bookMeetingRequestSchema.parse(request.body);
  const session = getOrCreateBrowserSession(request, response);
  response.status(201).json(await store.bookMeeting({ ...body, userId: session.userId, sessionId: session.sessionId }));
});

app.post('/api/events/:eventId/delete', async (request, response) => {
  const body = deleteEventRequestSchema.parse(request.body);
  const session = getOrCreateBrowserSession(request, response);
  response.status(202).json({
    decision: await store.requestDeleteEvent(request.params.eventId, { ...body, userId: session.userId, sessionId: session.sessionId }),
  });
});

app.post('/api/meetings/:meetingId/readiness', async (request, response) => {
  const body = createReadinessJobRequestSchema.parse(request.body);
  const session = getOrCreateBrowserSession(request, response);
  const job = await store.createReadinessJob({
    ...body,
    userId: session.userId,
    sessionId: session.sessionId,
    meetingId: request.params.meetingId,
  });
  console.log(`[broker] Queued readiness job ${job.id} meeting=${job.meetingId} session=${job.sessionId} createdBy=${job.createdBy}.`);
  response.status(202).json({ job });
});

app.post('/api/readiness-jobs/:jobId/suggestions/:suggestionId/accept', async (request, response) => {
  const decision = await store.acceptReadinessSuggestion(request.params.jobId, request.params.suggestionId);
  console.log(`[broker] Accepted readiness suggestion ${request.params.suggestionId} for job=${request.params.jobId}; decision=${decision.status} policy=${decision.policy}.`);
  response.json({
    decision,
  });
});

app.post('/api/proposals/:proposalId/patches/:patchId/confirm', async (request, response) => {
  response.json({
    decision: await store.confirmPatch(request.params.proposalId, request.params.patchId),
  });
});

app.post('/api/proposals/:proposalId/patches/:patchId/reject', async (request, response) => {
  response.json({
    decision: await store.rejectPatch(request.params.proposalId, request.params.patchId),
  });
});

app.post('/api/undo', async (_request, response) => {
  response.json({ audit: await store.undoLastApplied() });
});

app.get('/api/planner/next-intent', async (request, response) => {
  const workerId = typeof request.query.workerId === 'string' ? request.query.workerId : 'planner';
  const claimed = await store.claimNextIntent(workerId);
  if (!claimed) {
    response.status(204).send();
    return;
  }
  response.json(claimed);
});

app.post('/api/planner/proposals', async (request, response) => {
  const body = submitProposalRequestSchema.parse(request.body);
  const proposal = proposalSchema.parse(body.proposal);
  const decisions = await store.submitProposal(proposal);
  response.status(202).json({ decisions });
});

app.get('/api/planner/next-readiness-job', async (request, response) => {
  const workerId = typeof request.query.workerId === 'string' ? request.query.workerId : 'readiness-agent';
  const claimed = await store.claimNextReadinessJob(workerId);
  if (!claimed) {
    response.status(204).send();
    return;
  }
  console.log(`[broker] Claimed readiness job ${claimed.job.id} for worker=${workerId} meeting=${claimed.job.meetingId} session=${claimed.job.sessionId}.`);
  response.json(claimed);
});

app.post('/api/planner/readiness-jobs/:jobId/progress', async (request, response) => {
  const body = readinessProgressRequestSchema.parse(request.body);
  const job = await store.recordReadinessProgress(request.params.jobId, body);
  console.log(`[broker] Readiness job ${job.id} progress step=${body.stepId} label="${body.label}".`);
  response.json({
    job,
  });
});

app.post('/api/planner/readiness-jobs/:jobId/result', async (request, response) => {
  const body = readinessResultRequestSchema.parse(request.body);
  const job = await store.completeReadinessJob(request.params.jobId, body.suggestions);
  console.log(`[broker] Readiness job ${job.id} completed with ${body.suggestions.length} suggestion(s): ${body.suggestions.map((suggestion) => suggestion.title).join(' | ')}`);
  response.status(202).json({
    job,
  });
});

app.post('/api/planner/readiness-jobs/:jobId/fail', async (request, response) => {
  const body = readinessFailureRequestSchema.parse(request.body);
  const job = await store.failReadinessJob(request.params.jobId, body.error);
  console.error(`[broker] Readiness job ${job.id} failed: ${body.error}`);
  response.json({
    job,
  });
});

app.get('/api/agent/meetings/:meetingId', async (request, response) => {
  response.json(await store.getMeeting(request.params.meetingId));
});

app.get('/api/agent/calendar-window', async (request, response) => {
  const meetingId = typeof request.query.meetingId === 'string' ? request.query.meetingId : undefined;
  if (!meetingId) {
    response.status(400).json({ error: 'meetingId is required.' });
    return;
  }
  const days = typeof request.query.days === 'string' ? Number(request.query.days) : 7;
  response.json(await store.getCalendarWindow(meetingId, days));
});

app.get('/api/agent/weather', async (request, response) => {
  const meetingId = typeof request.query.meetingId === 'string' ? request.query.meetingId : undefined;
  if (!meetingId) {
    response.status(400).json({ error: 'meetingId is required.' });
    return;
  }
  response.json(await getWeatherForMeeting(meetingId));
});

app.get('/api/agent/travel', async (request, response) => {
  const meetingId = typeof request.query.meetingId === 'string' ? request.query.meetingId : undefined;
  if (!meetingId) {
    response.status(400).json({ error: 'meetingId is required.' });
    return;
  }
  response.json(await store.getTravelPlanForMeeting(meetingId));
});

app.get('/api/agent/materials', async (request, response) => {
  const meetingId = typeof request.query.meetingId === 'string' ? request.query.meetingId : undefined;
  if (!meetingId) {
    response.status(400).json({ error: 'meetingId is required.' });
    return;
  }
  response.json(await store.getMeetingMaterials(meetingId));
});

app.post('/api/demo/reset', async (_request, response) => {
  response.json(await store.reset());
});

app.post('/api/demo/seed', async (_request, response) => {
  response.json(await store.reset());
});

app.post('/api/demo/generate-build-week', async (_request, response) => {
  response.json(await store.generateBuildWeekCalendar());
});

app.post('/api/demo/clear-events', async (_request, response) => {
  response.json(await store.clearCalendarEvents());
});

app.post('/api/demo/simulate-conflict', async (_request, response) => {
  response.json({ decision: await store.simulateConflict() });
});

app.post('/api/demo/trigger-replanning', async (_request, response) => {
  response.status(202).json({ intent: await store.triggerReplanning() });
});

app.post('/api/demo/trigger-readiness', async (_request, response) => {
  response.status(202).json({ job: await store.triggerReadinessDemo() });
});

app.post('/api/demo/replay-last-drag', async (_request, response) => {
  response.status(202).json({ intent: await store.replayLastDrag() });
});

app.post('/api/demo/clear-pending', async (_request, response) => {
  response.json({ cleared: await store.clearPending() });
});

app.get('/api/demo/agent-session', async (request, response) => {
  response.json(await store.agentSessionSummary(getOrCreateBrowserSession(request, response)));
});

app.post('/api/demo/agent-session', async (request, response) => {
  response.json(await store.agentSessionSummary(getOrCreateBrowserSession(request, response)));
});

app.use(((error: unknown, _request: Request, response: Response, _next) => {
  if (error instanceof BrokerError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }

  if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') {
    response.status(400).json({ error: 'Invalid request payload.', details: error });
    return;
  }

  console.error('[broker] unhandled error', error);
  response.status(500).json({ error: 'Unexpected broker error.' });
}) satisfies ErrorRequestHandler);

async function getWeatherForMeeting(meetingId: string) {
  if (!weatherBaseUrl) {
    return store.getWeatherForMeeting(meetingId);
  }

  const meeting = await store.getMeeting(meetingId);
  const weatherResponse = await fetch(new URL('/forecast', weatherBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meetingId,
      location: meeting.location ?? 'Seattle',
      forecastAt: meeting.start,
    }),
  });

  if (!weatherResponse.ok) {
    const detail = await weatherResponse.text();
    throw new BrokerError(
      502,
      `Weather service returned ${weatherResponse.status} ${weatherResponse.statusText}${detail ? `: ${detail.slice(0, 200)}` : '.'}`,
    );
  }

  let payload: unknown;
  try {
    payload = await weatherResponse.json();
  } catch {
    throw new BrokerError(502, 'Weather service returned a non-JSON forecast payload.');
  }

  const parsed = weatherReportSchema.safeParse(payload);
  if (!parsed.success) {
    throw new BrokerError(502, 'Weather service returned an invalid forecast payload.');
  }

  return parsed.data;
}

try {
  console.log(`[broker] Starting calendar broker on port ${port}.`);
  console.log('[broker] Loading calendar store.');
  await store.load();
  ready = true;
  app.listen(port, () => {
    console.log(`[broker] Calendar broker listening on http://localhost:${port}`);
    console.log('[broker] Calendar writes are authorized here; planners only submit CalendarPatch proposals.');
  });
} catch (error) {
  ready = false;
  console.error('[broker] Calendar broker startup failed.', error);
  process.exitCode = 1;
  throw error;
}
