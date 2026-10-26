export const DEFAULT_GEMMA_MODELS = ["gemma-4-31b-it", "gemma-4-26b-a4b-it"];

const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

export function parseGemmaModels(value = process.env.GEMMA_MODELS) {
  const models = String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return models.length ? [...new Set(models)] : [...DEFAULT_GEMMA_MODELS];
}

export function isRetryableGeminiError(error) {
  const status = Number(error?.status);
  if (status) return RETRYABLE_STATUS_CODES.has(status);

  const networkDetails = [
    error?.name,
    error?.message,
    error?.code,
    error?.cause?.message,
    error?.cause?.code,
  ].filter(Boolean).join(" ");

  return /fetch failed|failed to fetch|network error|network request failed|econn(?:reset|refused|aborted)|eai_again|enotfound|etimedout|timed out|timeout|aborterror|und_err|socket hang up/i.test(networkDetails);
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function generateWithGemmaFallback({
  models,
  generate,
  signal,
  maxAttempts = 2,
  baseDelayMs = 1000,
  jitterMs = 300,
  random = Math.random,
  sleep = wait,
  logger = console,
}) {
  if (!models.length) throw new Error("At least one Gemma model must be configured.");

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason || new Error("The extraction request was cancelled.");

      try {
        return { result: await generate(model, attempt), model };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.model = model;

        if (signal?.aborted) throw signal.reason || failure;

        if (!isRetryableGeminiError(failure)) throw failure;

        if (attempt < maxAttempts) {
          const delayMs = baseDelayMs * (2 ** (attempt - 1)) + Math.floor(random() * jitterMs);
          logger.warn(`[Gemini retry] ${model} attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms.`);
          await sleep(delayMs);
          continue;
        }

        const fallbackModel = models[modelIndex + 1];
        if (!fallbackModel) throw failure;

        logger.warn(`[Gemini fallback] ${model} failed after ${maxAttempts} attempts; trying ${fallbackModel}.`);
        break;
      }
    }
  }

  throw new Error("All configured Gemma models failed.");
}
