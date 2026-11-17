"use client";

import IconSparkleLoader from "@/media/IconSparkleLoader";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogLevel, SimliClient } from "simli-client";
import DottedFace from "./Components/DottedFace";
import VideoBox from "./Components/VideoBox";
import cn from "./utils/TailwindMergeAndClsx";
import { GeminiAudioToSimli, PCM_RATE_16K, bytesToBase64, startMicCapture, type MicCapture } from "./utils/audio";
import { explainGeminiClose } from "./utils/geminiErrors";
import { explainSimliError } from "./utils/simliErrors";

/**
 * Gemini Live API (WebSocket) speaking through a Simli avatar.
 *
 *   1. Microphone permission (echo cancellation on).
 *   2. Our server mints a Simli session token (POST /api/simli-token).
 *   3. Simli starts first; start() resolves when the avatar is on screen.
 *   4. Only then the Gemini session opens: our server mints a single-use ephemeral
 *      token locked to the model, prompt and voice (POST /api/gemini-token), and the
 *      page opens the Live API WebSocket with it. After setupComplete the mic streams
 *      PCM16 16 kHz to Gemini and the model greets first.
 *   5. Gemini's voice (PCM16 24 kHz) is resampled to 16 kHz and sent to Simli as raw
 *      PCM (sendAudioData). It is never played directly: the user hears Simli's
 *      in-sync voice only. On barge-in (serverContent.interrupted) Simli's buffer is cleared.
 *   6. Ending either side (button, Simli time/idle limit, Gemini closing or goAway,
 *      errors, unmount, pagehide) tears everything down.
 *
 * Docs: https://docs.simli.com/api-reference/javascript
 *       https://aistudio.google.com/docs/live-api/get-started-websocket
 *       https://aistudio.google.com/docs/live-api/ephemeral-tokens
 */

type Status = "idle" | "starting" | "live";

interface SimliGeminiProps {
  avatarName: string;
}

// Live API endpoint for ephemeral tokens (v1beta, "Constrained", token in access_token).
const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
/** Mic chunk length sent to Gemini (Google recommends 20-40 ms). */
const MIC_CHUNK_MS = 40;
/** How long to wait for Gemini's setupComplete before giving up. */
const SETUP_TIMEOUT_MS = 15_000;
/** Text that starts the conversation, so the model greets first (the greeting rule is in the server-side prompt). */
const GREETING_TRIGGER = "Hello!";

// The Live API server messages this app handles.
// https://aistudio.google.com/api-reference/live#BidiGenerateContentServerMessage
type GeminiServerMessage = {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    interrupted?: boolean;
    generationComplete?: boolean;
    turnComplete?: boolean;
  };
  goAway?: { timeLeft?: string };
};

/** A failure on the Gemini side: shown as is (Simli's error hints don't apply). */
class GeminiError extends Error {}

/** Reads `{ error }` from a failed response of our own API routes. */
async function routeError(res: Response, what: string, ErrorType: new (message: string) => Error = Error): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ErrorType(`${what} failed (${res.status}): ${body?.error ?? res.statusText}`);
}

const utf8 = new TextDecoder();

export default function SimliGemini({ avatarName }: SimliGeminiProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);

  // Simli's video and in-sync audio.
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const simliRef = useRef<SimliClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCaptureRef = useRef<MicCapture | null>(null);
  const audioOutRef = useRef<GeminiAudioToSimli | null>(null);
  // Set when Gemini announces it will close the connection (goAway).
  const goAwayRef = useRef(false);
  // Bumped on every cleanup, so an in-flight start() can tell it was cancelled.
  const attemptRef = useRef(0);

  /** Idempotent: safe to call from any handler, any number of times. */
  const cleanup = useCallback(() => {
    attemptRef.current += 1;

    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);

    audioOutRef.current = null;
    goAwayRef.current = false;

    const simli = simliRef.current;
    simliRef.current = null;
    // pagehide can't await this; Simli also ends the session when the connection drops.
    simli?.stop().catch(() => {});

    setSpeaking(false);
  }, []);

  /** End the whole conversation, optionally telling the user why. */
  const end = useCallback(
    (message?: string) => {
      cleanup();
      setStatus("idle");
      if (message) setError(message);
    },
    [cleanup],
  );

  /** Sends PCM16 16 kHz to Simli; never throws (the socket may be closing). */
  const toSimli = useCallback((pcm: Uint8Array) => {
    if (!pcm.length) return;
    try {
      simliRef.current?.sendAudioData(pcm);
    } catch (err) {
      console.warn("Simli dropped audio:", err);
    }
  }, []);

  const handleGeminiMessage = useCallback(
    (msg: GeminiServerMessage) => {
      const content = msg.serverContent;
      if (content) {
        // One event can carry several parts (audio and transcript): handle every part.
        for (const part of content.modelTurn?.parts ?? []) {
          const blob = part.inlineData;
          // Audio is "audio/pcm;rate=24000"; skip anything else (the model only answers with audio).
          if (blob?.data && audioOutRef.current && (!blob.mimeType || blob.mimeType.startsWith("audio/pcm"))) {
            toSimli(audioOutRef.current.push(blob.data, blob.mimeType));
          }
        }
        if (content.interrupted) {
          // Barge-in: Gemini cancelled its reply; drop what Simli hasn't spoken yet.
          audioOutRef.current?.reset();
          simliRef.current?.ClearBuffer();
        } else if (content.turnComplete || content.generationComplete) {
          if (audioOutRef.current) toSimli(audioOutRef.current.flush());
        }
      }
      if (msg.goAway) {
        // Gemini will close this connection soon (session/connection time limit).
        // The close handler ends the conversation with a clear message.
        console.info("Gemini goAway, time left:", msg.goAway.timeLeft);
        goAwayRef.current = true;
      }
    },
    [toSimli],
  );

  const start = useCallback(async () => {
    // Runs from a click, so the browser allows audio playback.
    cleanup();
    const attempt = attemptRef.current;
    const cancelled = () => attemptRef.current !== attempt;
    setError("");
    setStatus("starting");

    try {
      // 1. Microphone.
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (cancelled()) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      micStreamRef.current = mic;

      // 2. Simli session token from our own server. No API key ever reaches the browser.
      const tokenRes = await fetch("/api/simli-token", { method: "POST" });
      if (!tokenRes.ok) throw await routeError(tokenRes, "Avatar session");
      const { session_token } = (await tokenRes.json()) as { session_token: string };
      if (cancelled()) return;

      // 3. Simli first: the avatar must be ready before the model says anything.
      const simli = new SimliClient(session_token, videoRef.current!, audioRef.current!, null, LogLevel.ERROR);
      simli.on("error", (detail) => {
        if (simliRef.current === simli) end(explainSimliError(`Simli error: ${detail}`));
      });
      simli.on("stop", () => {
        // Simli ended the session (maxSessionLength / maxIdleTime). Our own stop() clears simliRef first.
        if (simliRef.current === simli) end("The avatar session ended.");
      });
      simli.on("speaking", () => setSpeaking(true));
      simli.on("silent", () => setSpeaking(false));
      simli.on("destination", (info) => console.info("Simli session:", info));
      simliRef.current = simli;
      await simli.start(); // resolves when the first video frame is on screen
      if (cancelled()) return;

      // 4. Gemini Live: a single-use token locked to the server-side config (see app/api/gemini-token).
      const geminiRes = await fetch("/api/gemini-token", { method: "POST" });
      if (!geminiRes.ok) throw await routeError(geminiRes, "Voice session", GeminiError);
      const { token, model } = (await geminiRes.json()) as { token: string; model: string };
      if (cancelled()) return;

      const ws = new WebSocket(`${GEMINI_WS_URL}?access_token=${encodeURIComponent(token)}`);
      ws.binaryType = "arraybuffer"; // Gemini sends JSON in binary frames
      wsRef.current = ws;
      audioOutRef.current = new GeminiAudioToSimli();

      // Resolves on setupComplete; rejects if the socket closes or errors first.
      let setupDone: () => void = () => {};
      let setupFailed: (err: Error) => void = () => {};
      const setupComplete = new Promise<void>((resolve, reject) => {
        setupDone = resolve;
        setupFailed = reject;
      });
      let isSetUp = false;

      ws.onopen = () => {
        // The config (prompt, voice, modality) is locked in the token; only the model is named here.
        ws.send(JSON.stringify({ setup: { model: `models/${model}` } }));
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        let msg: GeminiServerMessage;
        try {
          const text = typeof ev.data === "string" ? ev.data : utf8.decode(ev.data as ArrayBuffer);
          msg = JSON.parse(text) as GeminiServerMessage;
          if (!msg || typeof msg !== "object") throw new Error("not an object");
        } catch (err) {
          console.warn("Ignoring unreadable Gemini message:", err);
          return;
        }
        if (msg.setupComplete && !isSetUp) {
          isSetUp = true;
          setupDone();
        }
        handleGeminiMessage(msg);
      };
      ws.onerror = () => {
        // A close event with the code always follows; the reason is reported there.
        console.warn("Gemini WebSocket error");
      };
      ws.onclose = (ev) => {
        const message = goAwayRef.current
          ? "The conversation reached Gemini's session time limit. Click Test Interaction to start a new one."
          : ev.code === 1000 && !ev.reason
            ? "Gemini ended the conversation."
            : explainGeminiClose(ev.code, ev.reason);
        if (!isSetUp) {
          setupFailed(new GeminiError(message));
          return;
        }
        // Gemini closed the session (time limit, token expiry, error). Our own close clears wsRef first.
        if (wsRef.current === ws) end(message);
      };

      const timeout = setTimeout(() => setupFailed(new GeminiError("Gemini didn't finish setting up the session in time.")), SETUP_TIMEOUT_MS);
      try {
        await setupComplete;
      } finally {
        clearTimeout(timeout);
      }
      if (cancelled()) return;

      // 5. Stream the microphone to Gemini (PCM16 16 kHz).
      const capture = await startMicCapture(mic, PCM_RATE_16K, MIC_CHUNK_MS, (pcm) => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
        const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        ws.send(
          JSON.stringify({ realtimeInput: { audio: { data: bytesToBase64(bytes), mimeType: `audio/pcm;rate=${PCM_RATE_16K}` } } }),
        );
      });
      if (cancelled()) {
        capture.stop();
        return;
      }
      micCaptureRef.current = capture;

      // The model greets first.
      ws.send(JSON.stringify({ realtimeInput: { text: GREETING_TRIGGER } }));
      setStatus("live");
    } catch (err) {
      if (cancelled()) return; // the user pressed stop, or the page went away
      console.error("Start failed:", err);
      const raw = err instanceof Error ? err.message : String(err);
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in the browser and try again."
          : err instanceof GeminiError
            ? raw
            : explainSimliError(raw);
      end(message);
    }
  }, [cleanup, end, handleGeminiMessage]);

  // Stop everything on unmount and when the tab is closed, so sessions don't keep running.
  useEffect(() => {
    const onHide = () => cleanup();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      cleanup();
    };
  }, [cleanup]);

  const showDottedFace = status === "idle";

  return (
    <div className="w-full">
      {showDottedFace && <DottedFace />}
      <div className={cn("transition-all duration-300", showDottedFace ? "h-0 overflow-hidden" : "h-auto")}>
        <VideoBox video={videoRef} audio={audioRef} />
      </div>

      <div className="flex flex-col items-center w-full max-w-[350px] mx-auto">
        {status === "idle" ? (
          <button
            onClick={start}
            className={cn(
              "w-full h-[52px] mt-4 bg-simliblue text-white py-3 px-6 rounded-[100px] transition-all duration-300 hover:text-black hover:bg-white hover:rounded-sm",
              "flex justify-center items-center",
            )}
          >
            <span className="font-abc-repro-mono font-bold w-[164px]">Test Interaction</span>
          </button>
        ) : (
          <div className="flex items-center gap-4 w-full">
            <button
              onClick={() => end()}
              className="mt-4 group text-white flex-grow bg-red hover:rounded-sm hover:bg-white h-[52px] px-6 rounded-[100px] transition-all duration-300 flex justify-center items-center"
            >
              {status === "starting" ? (
                <IconSparkleLoader className="h-[20px] w-auto animate-loader group-hover:invert" />
              ) : (
                <span className="font-abc-repro-mono group-hover:text-black font-bold w-[164px] transition-all duration-300">
                  Stop Interaction
                </span>
              )}
            </button>
          </div>
        )}
        {status === "live" && (
          <p className="mt-3 font-abc-repro-mono text-xs text-gray-400" aria-live="polite">
            {speaking ? `${avatarName} is speaking…` : "Listening…"}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 max-w-[350px] text-center text-red">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
