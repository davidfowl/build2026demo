// Module: direct calendar-planning worker loop.
// Exports: runPlanningLoop.
// Does: claims queued user planning intents from the broker, loads current state,
// builds CalendarPatch proposals, and submits those proposals back to the broker.
// Why: keeps generated planning suggestions outside the API process while still
// requiring the broker to approve every calendar mutation.

import { claimNextPlanningIntent, fetchState, submitProposal } from './api-client';
import { delay, pollMs, workerId } from './config';
import { createProposal } from './proposal-factory';

export async function runPlanningLoop(): Promise<void> {
  for (;;) {
    try {
      await processOneIntent();
    } catch (error) {
      console.error('[planner] planning loop error', error);
    }
    await delay(pollMs);
  }
}

async function processOneIntent(): Promise<void> {
  const claimed = await claimNextPlanningIntent(workerId);
  if (!claimed) {
    return;
  }

  const { intent, event } = claimed;
  const state = await fetchState();
  const proposal = createProposal(intent, event, state);
  const decisions = await submitProposal(proposal);
  console.log(`[planner] submitted ${proposal.patches.length} patch(es) for ${intent.id}; broker returned ${decisions.length} decision(s)`);
}
