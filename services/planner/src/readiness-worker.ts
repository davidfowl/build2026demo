// Module: meeting-readiness worker loop.
// Exports: runReadinessLoop.
// Does: claims queued readiness jobs, gathers broker-approved meeting context,
// records UI-visible progress, invokes the hosted agent, and posts validated
// suggestions or failures back to the broker.
// Why: separates long-running agent work from the API process while keeping the
// broker in control of what context is read and when jobs are canceled.

import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import {
  claimNextReadinessJob,
  completeReadinessJob,
  failReadinessJob as submitReadinessFailure,
  fetchState,
  getCalendarWindow,
  getMaterials,
  getMeeting,
  getTravel,
  getWeather,
  recordReadinessProgress,
} from './api-client';
import { delay, pollMs, toolDelayMs, workerId } from './config';
import { invokeHostedAgent } from './hosted-agent-client';
import { suggestionTitles } from './model-output';
import {
  type HostedAgentContext,
  type MeetingReadinessJob,
  hostedAgentContextSchema,
} from './shared';

const tracer = trace.getTracer('build2026-planner-agent');

export async function runReadinessLoop(): Promise<void> {
  for (;;) {
    try {
      await processOneReadinessJob();
    } catch (error) {
      console.error('[planner] readiness loop error', error);
    }
    await delay(pollMs);
  }
}

async function processOneReadinessJob(): Promise<void> {
  const job = await claimNextReadinessJob(workerId);
  if (!job) {
    return;
  }

  console.log(`[planner] claimed readiness job ${job.id} meeting=${job.meetingId} session=${job.sessionId}.`);

  try {
    await runReadinessAnalysis(job);
  } catch (error) {
    await failReadinessJob(job.id, error instanceof Error ? error.message : 'Unknown readiness agent failure.');
    throw error;
  }
}

async function runReadinessAnalysis(job: MeetingReadinessJob): Promise<void> {
  return tracer.startActiveSpan('calendar.readiness.analyze', {
    attributes: {
      'app.readiness.job_id': job.id,
      'app.meeting.id': job.meetingId,
      'app.session.id': job.sessionId,
      'app.user.id': job.userId,
    },
  }, async (span) => {
    try {
      console.log(`[planner] starting readiness analysis job=${job.id} meeting=${job.meetingId} via hosted agent.`);
      const context = await loadReadinessContext(job);
      if (!context) {
        console.log(`[planner] readiness job ${job.id} stopped before context load completed.`);
        return;
      }
      span.setAttribute('app.meeting.title', context.meeting.title);
      console.log(`[planner] loaded readiness context job=${job.id} meeting="${context.meeting.title}" calendarEvents=${context.calendarWindow.events.length} weather="${context.weather.condition}" travelMinutes=${context.travel.travelMinutes}.`);

      if (!(await recordProgress(job.id, 'hosted-agent', 'Invoking Foundry hosted agent', 'Sent the scoped meeting context to the isolated hosted-agent session.'))) {
        return;
      }
      const suggestions = await invokeHostedAgent(context);
      span.setAttribute('app.readiness.suggestions.count', suggestions.length);
      if (!(await recordProgress(job.id, 'agent-result', 'Received hosted-agent result', `Validated ${suggestions.length} readiness suggestion(s) from the hosted agent.`))) {
        return;
      }

      await completeReadinessJob(job.id, suggestions);
      console.log(`[planner] completed readiness job ${job.id} with ${suggestions.length} suggestion(s): ${suggestionTitles(suggestions)}`);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function loadReadinessContext(job: MeetingReadinessJob): Promise<HostedAgentContext | undefined> {
  // Each step records progress through the broker before calling the next API.
  // That lets the UI show live progress and lets cancellation stop the workflow.
  const meeting = await runReadinessStep(
    job,
    'meeting',
    'Reading meeting details',
    'Loaded title, attendees, location, and agenda notes.',
    'calendar.readiness.load_meeting',
    async () => getMeeting(job.meetingId),
  );
  if (!meeting) {
    return undefined;
  }

  const calendarWindow = await runReadinessStep(
    job,
    'calendar-window',
    'Scanning the 7-day calendar',
    'Looked for open focus windows and risky adjacent meetings.',
    'calendar.readiness.scan_calendar',
    async () => getCalendarWindow(job.meetingId, 7),
  );
  if (!calendarWindow) {
    return undefined;
  }

  const weather = await runReadinessStep(
    job,
    'weather',
    'Checking meeting-day weather',
    'Pulled location-specific weather so the advice is useful on the day.',
    'calendar.readiness.check_weather',
    async () => getWeather(job.meetingId),
  );
  if (!weather) {
    return undefined;
  }

  const travel = await runReadinessStep(
    job,
    'travel',
    'Estimating travel and setup buffer',
    'Compared the previous event with the meeting location.',
    'calendar.readiness.estimate_travel',
    async () => getTravel(job.meetingId),
  );
  if (!travel) {
    return undefined;
  }

  const materials = await runReadinessStep(
    job,
    'materials',
    'Reviewing agenda and materials',
    'Checked the meeting notes for a checklist and open questions.',
    'calendar.readiness.review_materials',
    async () => getMaterials(job.meetingId),
  );
  if (!materials) {
    return undefined;
  }

  return hostedAgentContextSchema.parse({ job, meeting, calendarWindow, weather, travel, materials });
}

async function runReadinessStep<T>(
  job: MeetingReadinessJob,
  stepId: string,
  label: string,
  detail: string,
  spanName: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  return tracer.startActiveSpan(spanName, {
    attributes: {
      'app.readiness.job_id': job.id,
      'app.readiness.step_id': stepId,
      'app.meeting.id': job.meetingId,
    },
  }, async (span: Span) => {
    try {
      if (!(await recordProgress(job.id, stepId, label, detail))) {
        span.setAttribute('app.readiness.stopped', true);
        return undefined;
      }
      if (!(await continueAfterDelay(job.id))) {
        span.setAttribute('app.readiness.stopped', true);
        return undefined;
      }
      return await action();
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function recordProgress(jobId: string, stepId: string, label: string, detail: string): Promise<boolean> {
  const current = await recordReadinessProgress(jobId, { stepId, label, detail });
  return current.status === 'running';
}

async function continueAfterDelay(jobId: string): Promise<boolean> {
  await delay(toolDelayMs);
  const state = await fetchState();
  return state.readinessJobs.find((job) => job.id === jobId)?.status === 'running';
}

async function failReadinessJob(jobId: string, error: string): Promise<void> {
  try {
    await submitReadinessFailure(jobId, error);
  } catch (failureError) {
    console.error(`[planner] failed to mark readiness job ${jobId} failed`, failureError);
  }
}
