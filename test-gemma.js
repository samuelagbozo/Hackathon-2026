import dotenv from "dotenv";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)) });

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY in .env");
  process.exit(1);
}

const client = new GoogleGenAI({ apiKey });
const model = process.env.GEMMA_MODEL || "gemma-4-31b-it";
const imagePath = fileURLToPath(new URL("test-poster.png", import.meta.url));
const mimeType = "image/png";
const prompt = "List the event name, date, time and location on this poster.";

console.log("=== Testing Gemma 4 with image ===");
console.log("Model:", model);
console.log("Image path:", imagePath);
console.log("Prompt:", prompt);

// Method A: inlineData with base64
console.log("\n--- Method A: inlineData (base64) ---");
try {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Data = imageBuffer.toString("base64");
  const startTime = Date.now();
  const responseA = await client.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          { text: prompt },
        ],
      },
    ],
  });
  console.log(`Method A succeeded in ${Date.now() - startTime}ms!`);
  console.log("Raw output text:");
  console.log(responseA.text);
} catch (error) {
  console.error("Method A failed with error:");
  console.error(error?.message || error);
  if (error?.status) console.error("Status:", error.status);
}

// Method B: Files API
console.log("\n--- Method B: Files API (upload) ---");
let uploadedFile = null;
try {
  const startTime = Date.now();
  console.log("Uploading file via client.files.upload...");
  uploadedFile = await client.files.upload({
    file: imagePath,
    mimeType,
  });
  console.log("Upload result:", JSON.stringify(uploadedFile, null, 2));

  // Test passing as fileData part
  console.log("Calling generateContent with fileData...");
  const responseB = await client.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: uploadedFile.uri,
              mimeType: uploadedFile.mimeType || mimeType,
            },
          },
          { text: prompt },
        ],
      },
    ],
  });
  console.log(`Method B succeeded in ${Date.now() - startTime}ms!`);
  console.log("Raw output text:");
  console.log(responseB.text);
} catch (error) {
  console.error("Method B failed with error:");
  console.error(error?.message || error);
  if (error?.status) console.error("Status:", error.status);
} finally {
  if (uploadedFile?.name) {
    try {
      console.log("Cleaning up uploaded file:", uploadedFile.name);
      await client.files.delete({ name: uploadedFile.name });
      console.log("File deleted successfully.");
    } catch (delErr) {
      console.warn("Failed to delete file:", delErr.message);
    }
  }
}

