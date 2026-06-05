import { claimNextPlanningIntent, fetchState, submitProposal } from './api-client';
import { delay, pollMs, workerId } from './config';
import { createProposal } from './proposal-factory';

// Handles direct calendar-planning intents. The broker API URL comes from
// API_BASE_URL, which apphost.mts injects from the api resource endpoint.
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
