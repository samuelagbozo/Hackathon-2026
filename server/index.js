import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import { fileURLToPath } from "node:url";
import { generateWithGemmaFallback, isRetryableGeminiError, parseGemmaModels } from "./geminiRetry.js";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const app = express();
const port = Number(process.env.PORT) || 3001;
const timezone = "Africa/Accra";
const models = parseGemmaModels(process.env.GEMMA_MODELS);
const model = models[0];
const busyMessage = "The AI model is busy right now. Please try again in a minute.";
const maxUploadBytes = 8 * 1024 * 1024;
const geminiCallTimeoutMs = 45_000;
const extractionRequestTimeoutMs = 50_000;
let extractionRequestSequence = 0;

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter(_request, file, callback) {
    if (!file.mimetype?.startsWith("image/")) {
      const error = new Error("Please upload an image file.");
      error.code = "INVALID_FILE_TYPE";
      callback(error);
      return;
    }

    callback(null, true);
  },
});

function logExtractionRequest(request, response, next) {
  request.extractionRequestId = ++extractionRequestSequence;
  request.extractionStartedAt = Date.now();
  console.info(`[extract ${request.extractionRequestId}] Request received.`);

  response.on("finish", () => {
    const durationMs = Date.now() - request.extractionStartedAt;
    console.info(`[extract ${request.extractionRequestId}] HTTP ${response.statusCode} completed in ${durationMs}ms.`);
  });

  response.on("close", () => {
    if (!response.writableFinished) {
      console.warn(`[extract ${request.extractionRequestId}] Client disconnected after ${Date.now() - request.extractionStartedAt}ms.`);
    }
  });

  next();
}

function setExtractionDeadline(request, response, next) {
  const controller = new AbortController();
  request.extractionSignal = controller.signal;

  const clearDeadline = () => clearTimeout(deadlineTimer);
  const deadlineTimer = setTimeout(() => {
    const elapsedMs = Date.now() - request.extractionStartedAt;
    console.error(`[extract ${request.extractionRequestId}] Overall ${extractionRequestTimeoutMs}ms request limit reached after ${elapsedMs}ms.`);
    controller.abort(new Error("Overall poster extraction request timed out."));
    if (!response.headersSent) response.status(503).json({ error: busyMessage, model });
  }, extractionRequestTimeoutMs);

  response.on("finish", clearDeadline);
  response.on("close", () => {
    clearDeadline();
    if (!response.writableFinished) controller.abort(new Error("Client disconnected."));
  });

  next();
}

function todayInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function buildPrompt(today) {
  return `You read campus event posters and return their visible information as structured data.

Today's date is ${today}. The event timezone is Africa/Accra.

Use only information visible in the poster. Never invent or infer missing details. If a field is missing, use null. If the year is missing from a visible event date, use the next upcoming occurrence of that month and day relative to today's date. Convert times such as "6pm" to 24-hour HH:MM format such as "18:00". If this image is not an event poster, set is_event_poster to false.

Return ONLY one valid JSON object with exactly these keys and no markdown fences or extra text:
{
  "is_event_poster": false,
  "title": null,
  "date": null,
  "start_time": null,
  "end_time": null,
  "location": null,
  "description": null,
  "confidence": "low",
  "notes": null
}

Use JSON null (not the text "null") for missing values. Keep notes short and mention any uncertainty in reading the poster.`;
}

function extractJsonObject(reply) {
  const withoutFences = String(reply ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");

  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error("No JSON object was returned.");
  }

  return JSON.parse(withoutFences.slice(firstBrace, lastBrace + 1));
}

function validateEvent(value) {
  const textFields = ["title", "date", "start_time", "end_time", "location", "description", "notes"];
  const isNullableText = (field) => value[field] === null || typeof value[field] === "string";
  const validConfidence = ["high", "medium", "low"].includes(value.confidence);
  const validDate = value.date === null || /^\d{4}-\d{2}-\d{2}$/.test(value.date);
  const validTime = (time) => time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.is_event_poster !== "boolean" || !validConfidence || !validDate) return false;
  if (!validTime(value.start_time) || !validTime(value.end_time)) return false;
  return textFields.every(isNullableText);
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, model, models, timezone });
});

app.post("/api/extract", logExtractionRequest, setExtractionDeadline, upload.single("poster"), async (request, response) => {
  if (response.headersSent || request.extractionSignal.aborted) return;

  if (!request.file) {
    console.warn(`[extract ${request.extractionRequestId}] No poster file was uploaded.`);
    response.status(400).json({ error: "Choose a poster image to upload.", model });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error(`[extract ${request.extractionRequestId}] GEMINI_API_KEY is not configured.`);
    response.status(500).json({ error: "The server is missing its GEMINI_API_KEY.", model });
    return;
  }

  try {
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const contents = [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: request.file.mimetype,
              data: request.file.buffer.toString("base64"),
            },
          },
          { text: buildPrompt(todayInTimezone(timezone)) },
        ],
      },
    ];
    const { result, model: answeredModel } = await generateWithGemmaFallback({
      models,
      signal: request.extractionSignal,
      logger: {
        warn: (message) => console.warn(`[extract ${request.extractionRequestId}] ${message}`),
      },
      generate: async (candidateModel, attempt) => {
        const callStartedAt = Date.now();
        console.info(`[extract ${request.extractionRequestId}] Trying ${candidateModel} (attempt ${attempt}/2).`);
        const callSignal = AbortSignal.any([
          AbortSignal.timeout(geminiCallTimeoutMs),
          request.extractionSignal,
        ]);

        try {
          const generated = await client.models.generateContent({
            model: candidateModel,
            contents,
            config: { abortSignal: callSignal },
          });
          console.info(`[extract ${request.extractionRequestId}] ${candidateModel} answered in ${Date.now() - callStartedAt}ms.`);
          return generated;
        } catch (error) {
          const safeMessage = String(error?.message || error?.name || "Unknown error").slice(0, 240);
          console.warn(`[extract ${request.extractionRequestId}] ${candidateModel} failed after ${Date.now() - callStartedAt}ms: ${safeMessage}`);
          throw error;
        }
      },
    });

    let event;
    try {
      if (typeof result.text !== "string" || !result.text.trim()) {
        throw new Error("Gemma returned an empty response.");
      }
      event = extractJsonObject(result.text);
      if (!validateEvent(event)) throw new Error("The JSON did not match the event format.");
    } catch (error) {
      console.warn(`[extract ${request.extractionRequestId}] Model returned an unreadable poster response: ${error.message}`);
      response.status(422).json({
        error: "Couldn't read the poster clearly, try a sharper, well-lit photo",
        model,
      });
      return;
    }

    console.info(`[extract ${request.extractionRequestId}] Extraction succeeded with ${answeredModel}.`);
    response.json({ event, timezone, model: answeredModel });
  } catch (error) {
    if (response.headersSent) return;

    if (request.extractionSignal.aborted) {
      console.error(`[extract ${request.extractionRequestId}] Extraction ended by request deadline after ${Date.now() - request.extractionStartedAt}ms.`);
      response.status(503).json({ error: busyMessage, model: error.model || model });
      return;
    }

    const status = Number(error?.status) || 0;
    const apiKey = process.env.GEMINI_API_KEY;
    const providerMessage = String(error?.message || "Unknown error")
      .replaceAll(apiKey || "\u0000", "[redacted]")
      .slice(0, 500);

    console.error(`[extract ${request.extractionRequestId}] Gemini poster extraction failed:`, {
      status: status || "network/unknown",
      name: error?.name || "Error",
      message: providerMessage,
    });

    if (isRetryableGeminiError(error)) {
      console.error(`[extract ${request.extractionRequestId}] All configured model attempts failed after ${Date.now() - request.extractionStartedAt}ms.`);
      response.status(503).json({ error: busyMessage, model: error.model || model });
      return;
    }

    let message;
    if (status === 400) {
      message = `Gemini rejected the request (400): ${providerMessage}`;
    } else if (status === 401 || status === 403) {
      message = `Gemini API access was denied (${status}). Check that the API key is valid, has no incompatible restrictions, and the Gemini API is enabled for its Google project.`;
    } else if (status === 404) {
      message = `Gemini could not find model "${error.model || model}". Check GEMMA_MODELS in .env.`;
    } else if (status) {
      message = `Gemini API returned HTTP ${status}: ${providerMessage}`;
    } else {
      message = `Could not reach the Gemini API: ${providerMessage}`;
    }

    console.error(`[extract ${request.extractionRequestId}] Final error after ${Date.now() - request.extractionStartedAt}ms: HTTP ${status || 500}.`);
    response.status(status === 400 || status === 401 ? status : 500).json({ error: message, model: error.model || model });
  }
});

app.use((error, request, response, _next) => {
  if (response.headersSent) return;

  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    console.error(`[extract ${request.extractionRequestId || "?"}] Upload exceeded the 8 MB limit.`);
    response.status(413).json({ error: "The image must be 8 MB or smaller.", model });
    return;
  }

  if (error.code === "INVALID_FILE_TYPE") {
    console.error(`[extract ${request.extractionRequestId || "?"}] Upload rejected: ${error.message}`);
    response.status(400).json({ error: error.message, model });
    return;
  }

  console.error(`[extract ${request.extractionRequestId || "?"}] Request failed:`, error);
  response.status(500).json({ error: "The server could not process that request.", model });
});

app.listen(port, () => {
  console.log(`Campus Poster Reader API listening on http://localhost:${port}`);
});
