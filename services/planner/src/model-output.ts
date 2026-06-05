import { z } from 'zod';
import {
  type ReadinessSuggestion,
  calendarPatchSchema,
  readinessSuggestionSchema,
} from './shared';

// The model is instructed to omit proposedPatch when there is no calendar edit,
// but LLMs sometimes return null. Normalize that at the model boundary and keep
// the internal broker schema strict.
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
