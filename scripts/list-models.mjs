// Lists the models each configured provider actually serves, so AI_MODEL can be set
// from real IDs instead of guesses. Reads keys from the environment or .env.local;
// never prints a key. Usage: npm run models
import { existsSync } from "node:fs";
import { PROVIDER_PRESETS } from "../lib/server/ai/config.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const REQUEST_TIMEOUT_MS = 15_000;

for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
  if (preset.protocol !== "openai-compatible" || !preset.baseURL) continue;
  const key = process.env.AI_API_KEY && process.env.AI_PROVIDER === id ? process.env.AI_API_KEY : preset.keyEnv ? process.env[preset.keyEnv] : undefined;
  if (preset.requiresKey && !key) continue;

  try {
    const response = await fetch(`${preset.baseURL.replace(/\/$/, "")}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.log(`${id}: HTTP ${response.status}`);
      continue;
    }
    const body = await response.json();
    const models = (body.data ?? []).map((m) => m.id).sort();
    console.log(`${id} (${models.length} models):\n  ${models.join("\n  ")}`);
  } catch (error) {
    if (!preset.requiresKey) continue; // local server not running: nothing to list
    console.log(`${id}: ${error instanceof Error ? error.message : error}`);
  }
}
