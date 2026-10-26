import assert from "node:assert/strict";
import test from "node:test";
import { generateWithGemmaFallback, isRetryableGeminiError, parseGemmaModels } from "./geminiRetry.js";

test("a fake 503 is retried once, then the next model succeeds", async (t) => {
  const models = ["gemma-primary", "gemma-fallback"];
  const calls = [];
  const delays = [];
  const logs = [];

  const answer = await generateWithGemmaFallback({
    models,
    generate: async (model) => {
      calls.push(model);
      if (model === models[0]) {
        const error = new Error("high demand");
        error.status = 503;
        throw error;
      }
      return { text: "fallback answered" };
    },
    sleep: async (delay) => delays.push(delay),
    random: () => 0,
    logger: { warn: (message) => logs.push(message) },
  });

  assert.deepEqual(calls, [models[0], models[0], models[1]]);
  assert.deepEqual(delays, [1000]);
  assert.equal(answer.model, models[1]);
  assert.equal(answer.result.text, "fallback answered");
  assert.equal(logs.filter((message) => message.includes("[Gemini retry]")).length, 1);
  assert.equal(logs.filter((message) => message.includes("[Gemini fallback]")).length, 1);
  t.diagnostic(logs.join("\n"));
});

test("network fetch failures are retryable", () => {
  assert.equal(isRetryableGeminiError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableGeminiError(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryableGeminiError(Object.assign(new Error("rate limited"), { status: 429 })), true);
  assert.equal(isRetryableGeminiError(Object.assign(new Error("server error"), { status: 500 })), true);
  assert.equal(isRetryableGeminiError(Object.assign(new Error("high demand"), { status: 503 })), true);
});

test("400 and 401 errors are not retryable", () => {
  assert.equal(isRetryableGeminiError(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(isRetryableGeminiError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
});

test("400 and 401 stop without retrying or falling back", async () => {
  for (const status of [400, 401]) {
    const calls = [];
    await assert.rejects(
      generateWithGemmaFallback({
        models: ["gemma-primary", "gemma-fallback"],
        generate: async (model) => {
          calls.push(model);
          throw Object.assign(new Error(`HTTP ${status}`), { status });
        },
        sleep: async () => assert.fail("Permanent errors must not wait before retrying."),
        logger: { warn: () => assert.fail("Permanent errors must not log a retry or fallback.") },
      }),
      (error) => error.status === status,
    );
    assert.deepEqual(calls, ["gemma-primary"]);
  }
});

test("model configuration preserves order and uses defaults when empty", () => {
  assert.deepEqual(parseGemmaModels("gemma-fast, gemma-large"), ["gemma-fast", "gemma-large"]);
  assert.deepEqual(parseGemmaModels(" , "), ["gemma-4-31b-it", "gemma-4-26b-a4b-it"]);
});
