// Module: model-output validation helpers for readiness suggestions.
// Exports: modelReadinessSuggestionSchema, parseCopilotReadinessSuggestions, and
// suggestionTitles.
// Does: extracts JSON from Copilot responses, accepts model-friendly nullish
// proposedPatch values, converts them into the stricter broker schema, and
// formats suggestion titles for logs.
// Why: keeps LLM response normalization at the model boundary so internal
// planner and broker code can rely on strict types.

import { z } from 'zod';
import {
  type ReadinessSuggestion,
  calendarPatchSchema,
  readinessSuggestionSchema,
} from './shared';

export const modelReadinessSuggestionSchema = readinessSuggestionSchema
  .extend({ proposedPatch: calendarPatchSchema.nullish() })
  .transform(({ proposedPatch, ...suggestion }) => proposedPatch ? { ...suggestion, proposedPatch } : suggestion);

const copilotReadinessResponseSchema = z.object({
  suggestions: z.array(modelReadinessSuggestionSchema).min(1),
});

export function parseCopilotReadinessSuggestions(content: string): ReadinessSuggestion[] {
  const parsed = copilotReadinessResponseSchema.parse(JSON.parse(extractJsonObject(content)));
  return parsed.suggestions;
}

export function suggestionTitles(suggestions: ReadinessSuggestion[]): string {
  return suggestions.map((suggestion) => `"${suggestion.title}"`).join(', ');
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedJson) {
    return fencedJson[1].trim();
  }

  throw new Error('Copilot SDK readiness response must be a JSON object.');
}
