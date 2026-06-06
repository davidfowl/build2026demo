// Module: Copilot SDK adapter for readiness generation inside the hosted agent.
// Exports: generateReadinessSuggestions.
// Does: builds the meeting-readiness prompt, creates a Copilot SDK session using
// the Azure AI Foundry model deployment, records GenAI telemetry, parses the JSON
// response, and returns typed readiness suggestions.
// Why: isolates model-provider setup and prompt/telemetry handling from the HTTP
// invocation server.

import { SpanStatusCode, context as otelContext, propagation, trace } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_WORKFLOW_NAME,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OUTPUT_TYPE_VALUE_JSON,
} from '@opentelemetry/semantic-conventions/incubating';
import type { CopilotSession, ProviderConfig, TelemetryConfig, TraceContext } from '@github/copilot-sdk';
import type { HostedAgentContext, ReadinessSuggestion } from './shared';
import {
  aiFoundryScope,
  copilotHome,
  copilotOtelFlushDelayMs,
  copilotTimeoutMs,
  copilotWorkingDirectory,
  delay,
  requiredEnv,
  withoutTrailingSlash,
} from './config';
import { parseCopilotReadinessSuggestions, suggestionTitles } from './model-output';

const tracer = trace.getTracer('build2026-planner-agent');
const copilotSystemName = 'github.copilot';
const copilotAgentName = 'build2026-meeting-readiness';

export async function generateReadinessSuggestions(context: HostedAgentContext): Promise<ReadinessSuggestion[]> {
  const suggestions = await runCopilotSdkPlanner(context);
  console.log(`[planner-agent] Copilot SDK authored job=${context.job.id} suggestions=${suggestions.length}: ${suggestionTitles(suggestions)}`);
  return suggestions;
}

async function runCopilotSdkPlanner(context: HostedAgentContext): Promise<ReadinessSuggestion[]> {
  const prompt = copilotPlannerPrompt(context);
  return tracer.startActiveSpan('copilot.sdk.invoke_agent', {
    attributes: {
      'app.readiness.job_id': context.job.id,
      'app.meeting.id': context.meeting.id,
      [ATTR_GEN_AI_SYSTEM]: copilotSystemName,
      [ATTR_GEN_AI_PROVIDER_NAME]: copilotSystemName,
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
      [ATTR_GEN_AI_AGENT_NAME]: copilotAgentName,
      [ATTR_GEN_AI_OUTPUT_TYPE]: GEN_AI_OUTPUT_TYPE_VALUE_JSON,
      [ATTR_GEN_AI_WORKFLOW_NAME]: 'meeting-readiness',
      [ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]: 'Return structured readiness suggestions as JSON; never call calendar write APIs.',
    },
  }, async (span) => {
    const { CopilotClient, approveAll } = await import('@github/copilot-sdk');
    const telemetry = copilotTelemetryConfig();
    span.setAttribute('copilot.telemetry.enabled', Boolean(telemetry));
    if (telemetry) {
      span.setAttribute('copilot.telemetry.exporter', telemetry.exporterType ?? 'otlp-http');
      span.setAttribute('copilot.telemetry.source', telemetry.sourceName ?? 'github.copilot');
      span.setAttribute('copilot.telemetry.capture_content', telemetry.captureContent ?? false);
      span.setAttribute('copilot.telemetry.flush_delay_ms', copilotOtelFlushDelayMs);
    }
    console.log(`[planner-agent] Copilot SDK telemetry ${telemetry ? `enabled source=${telemetry.sourceName} exporter=${telemetry.exporterType}` : 'disabled'}.`);
    const client = new CopilotClient({
      // The hosted agent must not use the developer's local Copilot account or
      // config files. Foundry provides model access through the explicit provider below.
      mode: 'empty',
      useLoggedInUser: false,
      baseDirectory: copilotHome,
      workingDirectory: copilotWorkingDirectory,
      logLevel: copilotLogLevel(),
      ...(telemetry ? { env: copilotRuntimeEnv(), telemetry } : {}),
      onGetTraceContext: currentTraceContext,
    });
    let session: CopilotSession | undefined;
    const shouldFlushCopilotTelemetry = Boolean(telemetry) && (telemetry?.exporterType ?? 'otlp-http') === 'otlp-http';

    try {
      const foundryProvider = await copilotFoundryProviderConfig();
      span.setAttribute('copilot.provider.base_url', foundryProvider.provider.baseUrl);
      span.setAttribute('copilot.provider.model_id', foundryProvider.modelId);
      span.setAttribute('copilot.provider.wire_model', foundryProvider.deploymentName);
      span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, foundryProvider.modelId);
      span.setAttribute('copilot.model', foundryProvider.modelId);
      session = await client.createSession({
        clientName: copilotAgentName,
        model: foundryProvider.modelId,
        provider: foundryProvider.provider,
        onPermissionRequest: approveAll,
        availableTools: [],
        skipCustomInstructions: true,
        enableConfigDiscovery: false,
        enableSkills: false,
      });
      span.addEvent(EVENT_GEN_AI_USER_MESSAGE, {
        [ATTR_GEN_AI_SYSTEM]: copilotSystemName,
        'app.readiness.job_id': context.job.id,
        'app.meeting.id': context.meeting.id,
        'app.meeting.title': context.meeting.title,
      });
      const response = await session.sendAndWait({ prompt }, copilotTimeoutMs);
      const content = response?.data.content.trim();
      if (!content) {
        throw new Error('Copilot SDK returned an empty readiness response.');
      }
      const suggestions = parseCopilotReadinessSuggestions(content);
      span.addEvent(EVENT_GEN_AI_ASSISTANT_MESSAGE, {
        [ATTR_GEN_AI_SYSTEM]: copilotSystemName,
        [ATTR_GEN_AI_OUTPUT_TYPE]: GEN_AI_OUTPUT_TYPE_VALUE_JSON,
        'app.readiness.suggestions.count': suggestions.length,
      });
      span.setAttribute('copilot.response.length', content.length);
      span.setAttribute('copilot.suggestions.count', suggestions.length);
      span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, foundryProvider.modelId);
      return suggestions;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (shouldFlushCopilotTelemetry) {
        await delay(copilotOtelFlushDelayMs);
      }
      if (session) {
        await session.disconnect();
      }
      const errors = await client.stop();
      for (const error of errors) {
        console.error('[planner-agent] Copilot SDK cleanup error', error);
      }
      span.end();
    }
  });
}

type CopilotFoundryProviderConfig = {
  provider: ProviderConfig;
  modelId: string;
  deploymentName: string;
  tokenExpiresOnTimestamp: number;
};

let cachedCopilotFoundryProvider: CopilotFoundryProviderConfig | undefined;

async function copilotFoundryProviderConfig(): Promise<CopilotFoundryProviderConfig> {
  if (cachedCopilotFoundryProvider && Date.now() < cachedCopilotFoundryProvider.tokenExpiresOnTimestamp - 5 * 60 * 1000) {
    return cachedCopilotFoundryProvider;
  }

  const { DefaultAzureCredential } = await import('@azure/identity');
  const token = await new DefaultAzureCredential().getToken(aiFoundryScope);
  // apphost.mts wires these with asHostedAgent(foundryProject) and withReference(chat).
  // Use the flattened reference variables; do not parse ConnectionStrings__chat.
  const projectEndpoint = requiredEnv('CALENDARPLANNING_URI');
  const deploymentName = requiredEnv('CHAT_MODELNAME');
  const provider: ProviderConfig = {
    type: 'openai',
    wireApi: 'completions',
    baseUrl: `${withoutTrailingSlash(projectEndpoint)}/openai/v1`,
    bearerToken: token.token,
    modelId: deploymentName,
    wireModel: deploymentName,
  };

  cachedCopilotFoundryProvider = {
    provider,
    modelId: deploymentName,
    deploymentName,
    tokenExpiresOnTimestamp: token.expiresOnTimestamp,
  };
  console.log(`[planner-agent] configured Foundry Copilot provider base=${provider.baseUrl} model=${deploymentName} deployment=${deploymentName}.`);
  return cachedCopilotFoundryProvider;
}

function copilotLogLevel(): 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all' {
  const value = process.env.COPILOT_LOG_LEVEL;
  return value === 'none' || value === 'error' || value === 'warning' || value === 'info' || value === 'debug' || value === 'all'
    ? value
    : 'info';
}

function copilotTelemetryConfig(): TelemetryConfig | undefined {
  const captureContent = booleanEnv('COPILOT_OTEL_CAPTURE_CONTENT')
    ?? booleanEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT')
    ?? true;
  // Aspire injects the standard OTLP endpoint when telemetry is available.
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!otlpEndpoint) {
    console.warn('[planner-agent] Copilot SDK telemetry disabled because no OTLP HTTP endpoint is configured.');
    return undefined;
  }

  return {
    otlpEndpoint,
    exporterType: 'otlp-http',
    sourceName: process.env.COPILOT_OTEL_SOURCE_NAME ?? 'build2026-planner-agent-copilot-sdk',
    captureContent,
  };
}

function copilotRuntimeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    OTEL_BSP_SCHEDULE_DELAY: process.env.COPILOT_OTEL_BSP_SCHEDULE_DELAY ?? '100',
    OTEL_BSP_EXPORT_TIMEOUT: process.env.COPILOT_OTEL_BSP_EXPORT_TIMEOUT ?? process.env.OTEL_BSP_EXPORT_TIMEOUT ?? '30000',
    OTEL_EXPORTER_OTLP_PROTOCOL: process.env.COPILOT_OTEL_EXPORTER_PROTOCOL ?? 'http/protobuf',
  };
}

function currentTraceContext(): TraceContext {
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
  return {
    traceparent: carrier.traceparent,
    tracestate: carrier.tracestate,
  };
}

function booleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function copilotPlannerPrompt(context: HostedAgentContext): string {
  return `
You are the meeting readiness planner for an Aspire Build 2026 demo.
Review the scoped meeting context and return broker-reviewed readiness suggestions.
Do not call tools. Do not call calendar write APIs. Do not return prose or markdown.
Return only a JSON object with a "suggestions" array matching this TypeScript shape:

type ReadinessSuggestion = {
  id: string;
  kind: "prep-time" | "weather-attire" | "travel-buffer" | "agenda-materials";
  title: string;
  detail: string;
  rationale?: string;
  proposedPatch?: {
    id: string;
    intentId: string;
    operation: "create" | "move" | "delete" | "update";
    eventId?: string;
    baseEtag?: string;
    changes: {
      title?: string;
      start?: string;
      end?: string;
      calendarId?: string;
      kind?: "focus" | "task" | "draft" | "meeting" | "team" | "prep";
      attendees?: string[];
      location?: string;
      description?: string;
    };
    reason: string;
    confidence: number;
  };
};

Create suggestions for prep time, weather/attire, travel/setup, and agenda/materials when supported by the context.
For proposed calendar changes, use intentId "${context.job.id}", calendarId "${context.meeting.calendarId}", ISO timestamps, and kind "prep".
If a suggestion has no calendar change, omit proposedPatch instead of setting it to null.

Context:
${JSON.stringify({
    meeting: context.meeting,
    calendarWindow: context.calendarWindow,
    weather: context.weather,
    travel: context.travel,
    materials: context.materials,
  })}
`.trim();
}
