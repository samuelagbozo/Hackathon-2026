import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const app = express();
const port = Number(process.env.PORT) || 3001;
const timezone = "Africa/Accra";
const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const maxUploadBytes = 8 * 1024 * 1024;

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
  response.json({ ok: true, model, timezone });
});

app.post("/api/extract", upload.single("poster"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "Choose a poster image to upload.", model });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    response.status(500).json({ error: "The server is missing its GEMINI_API_KEY.", model });
    return;
  }

  try {
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await client.models.generateContent({
      model,
      contents: [
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
      ],
    });

    let event;
    try {
      if (typeof result.text !== "string" || !result.text.trim()) {
        throw new Error("Gemma returned an empty response.");
      }
      event = extractJsonObject(result.text);
      if (!validateEvent(event)) throw new Error("The JSON did not match the event format.");
    } catch (error) {
      console.warn("Model returned an unreadable poster response:", error.message);
      response.status(422).json({
        error: "Couldn't read the poster clearly, try a sharper, well-lit photo",
        model,
      });
      return;
    }

    response.json({ event, timezone, model });
  } catch (error) {
    const status = Number(error?.status) || 0;
    const apiKey = process.env.GEMINI_API_KEY;
    const providerMessage = String(error?.message || "Unknown error")
      .replaceAll(apiKey || "\u0000", "[redacted]")
      .slice(0, 500);

    console.error("Gemini poster extraction failed:", {
      status: status || "network/unknown",
      name: error?.name || "Error",
      message: providerMessage,
    });

    let message;
    if (status === 400) {
      message = `Gemini rejected the request (400): ${providerMessage}`;
    } else if (status === 401 || status === 403) {
      message = `Gemini API access was denied (${status}). Check that the API key is valid, has no incompatible restrictions, and the Gemini API is enabled for its Google project.`;
    } else if (status === 404) {
      message = `Gemini could not find model "${model}". Check GEMINI_MODEL in .env.`;
    } else if (status === 429) {
      message = `Gemini API quota or rate limit reached (429): ${providerMessage}`;
    } else if (status) {
      message = `Gemini API returned HTTP ${status}: ${providerMessage}`;
    } else {
      message = `Could not reach the Gemini API: ${providerMessage}`;
    }

    response.status(500).json({ error: message, model });
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    response.status(413).json({ error: "The image must be 8 MB or smaller.", model });
    return;
  }

  if (error.code === "INVALID_FILE_TYPE") {
    response.status(400).json({ error: error.message, model });
    return;
  }

  console.error("Request failed:", error);
  response.status(500).json({ error: "The server could not process that request.", model });
});

app.listen(port, () => {
  console.log(`Campus Poster Reader API listening on http://localhost:${port}`);
});
