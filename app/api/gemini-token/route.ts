import { ApiError, GoogleGenAI, Modality } from "@google/genai";
import { avatar } from "@/app/avatar";
import {
  SESSION_MAX_SECONDS,
  UPSTREAM_TIMEOUT_MS,
  configErrorResponse,
  errorResponse,
  noStoreJson,
  rejectUnlessSessionsAllowed,
  requireEnv,
} from "@/lib/server-env";

/**
 * POST /api/gemini-token -> { token, model }
 *
 * Mints a short-lived, single-use Gemini Live API ephemeral token with
 * GEMINI_API_KEY. The key never leaves the server; the browser opens the Live
 * API WebSocket with the token instead.
 *
 * The token is locked to the session config from app/avatar.ts (model, system
 * instruction, voice, AUDIO responses): with liveConnectConstraints set and no
 * lockAdditionalFields, every config field is locked, and the Live API ignores
 * any config the browser sends. The browser can only talk to that one agent.
 *
 *   uses: 1                  one Live session per token
 *   newSessionExpireTime     the session must start within 60 s
 *   expireTime               after SESSION_MAX_SECONDS (+ a margin) Gemini rejects
 *                            messages on the session and may close it: this is the
 *                            server-side cap, and it needs no timer on this server,
 *                            so it also holds on serverless hosts.
 *
 * Docs: https://aistudio.google.com/docs/live-api/ephemeral-tokens
 *       https://aistudio.google.com/docs/live-api/session-management
 */

export const runtime = "nodejs";

/** Time the browser has to open the Live session with the token. */
const NEW_SESSION_WINDOW_MS = 60_000;
/** A few seconds after Simli's own maxSessionLength, so the page normally ends first. */
const TOKEN_LIFETIME_MS = (SESSION_MAX_SECONDS + 15) * 1000;

export async function POST() {
  // TODO before deploying: check the user's session / rate limit here (see README "Before you deploy").
  const refused = rejectUnlessSessionsAllowed();
  if (refused) return refused;

  let apiKey: string;
  try {
    apiKey = requireEnv("GEMINI_API_KEY");
  } catch (err) {
    return configErrorResponse(err);
  }

  // Ephemeral tokens are a v1beta (preview) Live API feature.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
  const now = Date.now();

  let tokenName: string | undefined;
  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + TOKEN_LIFETIME_MS).toISOString(),
        newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
        // Locked on the server: the browser can't change the model, prompt or voice.
        liveConnectConstraints: {
          model: avatar.gemini_model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: avatar.initialPrompt,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: avatar.gemini_voice } } },
          },
        },
        abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    });
    tokenName = token.name;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("Gemini auth_tokens error:", err.status, err.message);
      // Never forward a key-related message (it may describe the key); say what to fix instead.
      const keyProblem = err.status === 401 || err.status === 403 || /api[_ ]?key/i.test(err.message);
      const devDetail = keyProblem
        ? "GEMINI_API_KEY was rejected. Create a key at https://aistudio.google.com/apikey."
        : err.status === 429
          ? "Gemini (429): quota exceeded. On the free tier, wait a minute or check your limits at https://aistudio.google.com/rate-limit."
          : `Gemini (${err.status}): ${err.message.slice(0, 300)}`;
      return errorResponse(502, "Could not start the voice session.", devDetail);
    }
    console.error("Gemini auth_tokens request failed:", err);
    return errorResponse(502, "Could not start the voice session.", "The server could not reach Google.");
  }

  if (!tokenName?.startsWith("auth_tokens/")) {
    console.error("Gemini auth_tokens returned no usable token; refusing the session.");
    return errorResponse(502, "Could not start the voice session.");
  }

  return noStoreJson({ token: tokenName, model: avatar.gemini_model });
}
