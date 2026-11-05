import { generateText, type LanguageModel } from "ai";
import { createMergeGateway } from "merge-gateway-ai-sdk-provider";

import { ENV } from "../env.server";

/** Placeholder until the real template is provided; editable in Settings. */
export const DEFAULT_THUMBNAIL_TEMPLATE = `You write prompts for an AI image generator (ChatGPT) to create a YouTube thumbnail for a biology education channel.
Given the video's title and description, produce ONE prompt describing:
- a 16:9 (1280x720) composition
- the title (or a punchy 2-5 word version of it) as big, bold, highly readable text
- bright, clean colours with strong contrast
- one clear visual subject related to the topic (e.g. a cell, an organ, a molecule)
Output only the prompt text, nothing else.`;

const TIMEOUT_MS = 30_000;

let gateway: ReturnType<typeof createMergeGateway> | undefined;

export function defaultModel(): LanguageModel {
  if (!ENV.MERGE_GATEWAY_API_KEY) throw new Error("LLM is not configured (MERGE_GATEWAY_API_KEY missing)");
  gateway ??= createMergeGateway({ apiKey: ENV.MERGE_GATEWAY_API_KEY });
  return gateway(ENV.MERGE_MODEL || "openai/gpt-5.2");
}

export async function generateThumbnailPrompt(
  input: { title: string; description: string; template: string | null | undefined },
  model: LanguageModel = defaultModel(),
): Promise<string> {
  const { text } = await generateText({
    model,
    system: input.template?.trim() || DEFAULT_THUMBNAIL_TEMPLATE,
    prompt: `Title: ${input.title}\n\nDescription: ${input.description}`,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const out = text.trim();
  if (!out) throw new Error("The AI returned an empty prompt");
  return out;
}

/** Fixed-window in-memory limiter: `max` calls per `windowMs` per key. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((h) => t - h < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}
