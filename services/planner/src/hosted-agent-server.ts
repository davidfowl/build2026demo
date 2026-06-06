// Module: HTTP server for the Foundry hosted-agent invocation protocol.
// Exports: startHostedAgentServer.
// Does: exposes health probes and POST /invocations, normalizes incoming
// invocation envelopes, extracts trace context, calls the Copilot-backed
// readiness planner, and returns protocol-shaped assistant output.
// Why: bridges Foundry's hosted-agent runtime to this demo's typed readiness
// suggestion generator while preserving session affinity.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { context as otelContext, propagation, type TextMapGetter } from '@opentelemetry/api';
import { z } from 'zod';
import {
  hostedAgentInvocationEnvelopeSchema,
  hostedAgentInvocationResponseSchema,
} from './shared';
import { generateReadinessSuggestions } from './copilot-foundry-client';
import { requiredEnv, workerId } from './config';
import { suggestionTitles } from './model-output';

const incomingHeaderGetter: TextMapGetter<IncomingHttpHeaders> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => {
    const value = carrier[key.toLowerCase()];
    return Array.isArray(value) ? value.join(',') : value;
  },
};

const hostedAgentPortSchema = z.coerce.number().int().min(1).max(65535);
const sessionQuerySchema = z.object({
  agent_session_id: z.string().optional(),
});

export async function startHostedAgentServer(): Promise<never> {
  const port = hostedAgentPortSchema.parse(requiredEnv('PORT'));

  createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && ['/health', '/readiness', '/liveness'].includes(request.url ?? '')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ready', workerId, runtime: 'foundry-hosted-agent' }));
        return;
      }

      if (request.method === 'POST' && request.url?.includes('/invocations')) {
        // Foundry may send the context under different protocol-compatible
        // fields; the Zod envelope normalizes those into a single context.
        const invocation = hostedAgentInvocationEnvelopeSchema.parse(await readJsonBody(request));
        const agentContext = invocation.context;
        const sessionId = getHostedAgentSessionId(request.url, invocation.sessionId);
        console.log(`[planner-agent] invocation received job=${agentContext.job.id} meeting=${agentContext.meeting.id} session=${sessionId}.`);
        const traceContext = propagation.extract(otelContext.active(), request.headers, incomingHeaderGetter);
        const suggestions = await otelContext.with(traceContext, () => generateReadinessSuggestions(agentContext));
        const content = JSON.stringify({ suggestions });
        console.log(`[planner-agent] invocation completed job=${agentContext.job.id} suggestions=${suggestions.length}: ${suggestionTitles(suggestions)}`);

        const payload = hostedAgentInvocationResponseSchema.parse({
          invocation_id: randomUUID(),
          session_id: sessionId,
          output: { role: 'assistant', content },
          suggestions,
        });

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
        return;
      }

      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      console.error('[planner-agent] invocation failed', error);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid hosted-agent request.' }));
    }
  }).listen(port, () => {
    console.log(`[planner-agent] invocations endpoint listening on port ${port}.`);
  });

  return new Promise<never>(() => undefined);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as unknown;
}

function getHostedAgentSessionId(url: string, requestSessionId: string | undefined): string {
  const queryStart = url.indexOf('?');
  const requested = queryStart >= 0
    ? sessionQuerySchema.parse(Object.fromEntries(new URLSearchParams(url.slice(queryStart + 1)))).agent_session_id
    : undefined;
  // Foundry uses this id for session affinity. The worker sends a stable id
  // derived from the browser session unless a test override is provided.
  return process.env.FOUNDRY_AGENT_SESSION_ID ?? requested ?? requestSessionId ?? 'local-agent-session';
}
