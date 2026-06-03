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
} from '@build2026/shared';
import { BrokerError, CalendarStore } from './store';

const port = Number(process.env.PORT ?? 4310);
const store = new CalendarStore();
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'calendar-broker' });
});

app.get('/api/state', async (_request, response) => {
  response.json(await store.load());
});

app.get('/api/stream', async (request, response) => {
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
  const intent = await store.createIntent(body);
  response.status(202).json({ intent });
});

app.post('/api/meetings', async (request, response) => {
  const body = bookMeetingRequestSchema.parse(request.body);
  response.status(201).json(await store.bookMeeting(body));
});

app.post('/api/events/:eventId/delete', async (request, response) => {
  const body = deleteEventRequestSchema.parse(request.body);
  response.status(202).json({ decision: await store.requestDeleteEvent(request.params.eventId, body) });
});

app.post('/api/meetings/:meetingId/readiness', async (request, response) => {
  const body = createReadinessJobRequestSchema.parse(request.body);
  const job = await store.createReadinessJob({
    ...body,
    meetingId: request.params.meetingId,
  });
  response.status(202).json({ job });
});

app.post('/api/readiness-jobs/:jobId/suggestions/:suggestionId/accept', async (request, response) => {
  response.json({
    decision: await store.acceptReadinessSuggestion(request.params.jobId, request.params.suggestionId),
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
  response.json(claimed);
});

app.post('/api/planner/readiness-jobs/:jobId/progress', async (request, response) => {
  const body = readinessProgressRequestSchema.parse(request.body);
  response.json({
    job: await store.recordReadinessProgress(request.params.jobId, body),
  });
});

app.post('/api/planner/readiness-jobs/:jobId/result', async (request, response) => {
  const body = readinessResultRequestSchema.parse(request.body);
  response.status(202).json({
    job: await store.completeReadinessJob(request.params.jobId, body.suggestions),
  });
});

app.post('/api/planner/readiness-jobs/:jobId/fail', async (request, response) => {
  const body = readinessFailureRequestSchema.parse(request.body);
  response.json({
    job: await store.failReadinessJob(request.params.jobId, body.error),
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
  response.json(await store.getWeatherForMeeting(meetingId));
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

app.get('/api/demo/agent-session', async (_request, response) => {
  response.json(await store.agentSessionSummary());
});

app.post('/api/demo/agent-session', async (_request, response) => {
  response.json(await store.agentSessionSummary());
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

await store.load();
app.listen(port, () => {
  console.log(`[broker] Calendar broker listening on http://localhost:${port}`);
  console.log('[broker] Calendar writes are authorized here; planners only submit CalendarPatch proposals.');
});
