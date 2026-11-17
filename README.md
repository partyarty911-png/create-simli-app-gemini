# Create Simli App (Gemini)

A Next.js starter where a [Gemini Live API](https://aistudio.google.com/docs/live-api) voice agent talks to you through a real-time [Simli](https://simli.com) video avatar. It runs on a **free Google AI Studio key** (no card needed); see [Free tier](#free-tier).

- **Gemini Live over WebSocket** in the browser, with a short-lived, single-use [ephemeral token](https://aistudio.google.com/docs/live-api/ephemeral-tokens) that your server mints and locks to the model, prompt and voice.
- **Simli** turns the model's voice into a lip-synced avatar video. The page sends Gemini's audio to Simli as raw PCM (`sendAudioData`), and you hear Simli's in-sync audio only; the model's original audio is never played.
- **No API key reaches the browser.** Both keys stay in server-side environment variables; the browser only gets a Simli session token and a Gemini ephemeral token.

Simli docs: https://docs.simli.com

## How it works

```
Browser                                    Your Next.js server                   Providers
───────                                    ───────────────────                   ─────────
click "Test Interaction"
  ├─ mic permission (echo cancellation)
  ├─ POST /api/simli-token  ─────────────► SIMLI_API_KEY  ─────────────────────► Simli: session token
  ├─ SimliClient.start()  (avatar on screen)
  ├─ POST /api/gemini-token ─────────────► GEMINI_API_KEY + locked config ─────► Google: ephemeral token
  │                          ◄── token ───┘ (model, prompt, voice, AUDIO;
  │                                          1 use, expires after ~615 s)
  └─ WebSocket to the Live API (BidiGenerateContentConstrained?access_token=…)
       mic ─► PCM16 16 kHz (40 ms chunks) ─► realtimeInput.audio
       modelTurn audio, PCM16 24 kHz ─► resample to 16 kHz ─► simliClient.sendAudioData() ─► avatar video + voice
       serverContent.interrupted ─► simliClient.ClearBuffer()  (barge-in)
       goAway / close ─► end both sides with a message
```

1. The avatar starts first; the Gemini session opens only once the avatar is on screen, then the model greets the user.
2. The model, voice and instructions are set on the server (`app/avatar.ts`) and locked into the ephemeral token, so the browser can't change them.
3. Ending either side ends both: the Stop button, Simli's session limits, Gemini closing the session (time limit, `goAway`, errors), leaving the page or closing the tab.
4. Time limits (see [Limits](#limits)): Simli ends its session after 600 s, and Gemini stops accepting messages when the token expires, about 615 s after it was minted, even if the page doesn't end the session.

Audio formats: Gemini takes PCM16 16 kHz in and sends PCM16 24 kHz out; Simli takes PCM16 16 kHz. The resampler in `app/utils/audio.ts` converts 24 kHz to 16 kHz with a low-pass filter and keeps its state between chunks, so there are no clicks at chunk borders.

## Setup

Requirements: Node.js 20.9+ and a browser with microphone access (localhost or HTTPS).

1. Get your keys:
   - a Simli API key from https://app.simli.com;
   - a Gemini API key from https://aistudio.google.com/apikey (free; sign in with a Google account, no billing needed).

   If you want to try Simli but don't have access to these, ask in [Discord](https://discord.gg/yQx49zNF4d).

2. Create `.env.local` from the example and fill it in:

   ```bash
   cp .env.example .env.local
   ```

   ```bash
   SIMLI_API_KEY=...
   SIMLI_FACE_ID=14c60d62-6ebf-424d-b626-1f4f91c33b04   # optional; default is Simli's default Trinity-2 face
   GEMINI_API_KEY=...
   ```

   These are server-only variables. Never rename them to `NEXT_PUBLIC_*`.

3. Install and run:

   ```bash
   npm install
   npm run dev
   ```

4. Open http://127.0.0.1:3000 (the dev server listens on 127.0.0.1 only), click **Test Interaction**, allow the microphone, and talk. Headphones help if the avatar hears itself and interrupts.

Other scripts: `npm run build`, `npm start`, `npm run lint`, `npm run typecheck`.

## Customize the avatar

- **Prompt, voice, model:** edit `app/avatar.ts` (server-only).
  The default model is [`gemini-3.8-live`](https://aistudio.google.com/docs/models/gemini-3.8-live), Google's default Live model, which is free of charge on the free tier. Voices are Gemini's [prebuilt voices](https://aistudio.google.com/docs/speech-generation#voices) (listen in [AI Studio](https://aistudio.google.com/live)); for example `Kore` (female) and `Puck` (male). Match the voice to the face: the default face is a woman, so the default voice is `Kore`.
- **Face:** set `SIMLI_FACE_ID`. Use one of your own avatars (dashboard → Your Avatars) or a [preset face](https://docs.simli.com/api-reference/preset-faces):

  | Preset | Face ID |
  |---|---|
  | Simli's default Trinity-2 face (default) | `14c60d62-6ebf-424d-b626-1f4f91c33b04` |
  | Lukas | `a36d66df-a23d-4569-996b-d0e990019857` |
  | Mei | `084479bf-de7c-4df0-8d9c-5484193ecd27` |
  | Mateo | `99767950-9d68-4783-a305-9118006d3363` |

  If you change the face, update the name and voice in `app/avatar.ts` to match.
  You can also [create your own avatar](https://app.simli.com) from a photo.
- **Video shape:** the stream is 16:9 (1366x768, Trinity-2's full frame) to match the `aspect-video` player in `app/Components/VideoBox.tsx`. For a square layout, set `streaming_width: 768, streaming_height: 768` in `app/api/simli-token/route.ts` and change the player (and the placeholder in `app/Components/DottedFace.tsx`) to `aspect-square`. The two must match. See [Trinity-2 framing](https://docs.simli.com/api-reference/trinity-2).
- **Session limits:** `SESSION_MAX_SECONDS` (600) and `SIMLI_MAX_IDLE_SECONDS` (180) in `lib/server-env.ts`. See [Limits](#limits).

## Free tier

The free tier is meant for trying things out. Before you rely on it, know its [terms](https://aistudio.google.com/docs/terms):

- **Data use:** on the free tier ("Unpaid Services"), Google may use your prompts and the model's responses, including what users say to the avatar, to improve its products, and human reviewers may read them. This does not apply to users in the EEA, Switzerland or the UK, and not on the paid tier. See [How Google uses your data](https://aistudio.google.com/docs/terms#data-use-unpaid).
- **EEA, Switzerland, UK:** you may only use the **paid** tier when you make your app available to users there. To serve them, [set up billing](https://aistudio.google.com/docs/billing) on the project.
- **Limits:** free-tier rate limits are low, apply per Google Cloud project (not per key), and include how many Live sessions can run at once; when you hit one, Gemini refuses or closes the session (often with close code 1011) and the page says it's the free-tier limit. See your project's limits at https://aistudio.google.com/rate-limit and [Rate limits](https://aistudio.google.com/docs/rate-limits).
- **Session length:** independent of tier, a Live API audio session lasts up to 15 minutes and a single connection about 10 minutes; Gemini sends `goAway` before it closes. This app ends both sides at 10 minutes anyway. See [Session management](https://aistudio.google.com/docs/live-api/session-management).
- **Availability:** the Gemini API is only available in [some regions](https://aistudio.google.com/docs/available-regions). Ephemeral tokens are a preview feature.

Paid-tier prices for the Live models are on the [pricing page](https://aistudio.google.com/docs/pricing#gemini-3.8-live).

## Limits

What is capped, and by whom:

| | Cap | Enforced by |
|---|---|---|
| Simli session length | 600 s (`maxSessionLength`) | Simli's servers |
| Simli idle time | 180 s without audio (`maxIdleTime`) | Simli's servers |
| Gemini session | the ephemeral token's `expireTime`, ~615 s after it was minted: Gemini then rejects messages and may close the session | Google's servers. No timer on your server, so this also holds on serverless hosts. |
| Gemini token reuse | 1 session (`uses: 1`), which must start within 60 s (`newSessionExpireTime`) | Google's servers |
| Gemini connection | about 10 minutes per connection, 15 minutes per audio session; `goAway` first | Google's servers (Live API limits) |
| Either side | when the page closes, the user clicks Stop, or the other side ends | the browser code (not a security boundary) |

To make conversations longer than 10 minutes, raise the caps and add [session resumption](https://aistudio.google.com/docs/live-api/session-management#session-resumption) (reconnect with the resumption handle when `goAway` arrives) and [context window compression](https://aistudio.google.com/docs/live-api/session-management#context-window-compression).

## Before you deploy

The two API routes start sessions on your accounts (Simli minutes; Gemini quota or, on the paid tier, money), and as shipped they have **no authentication**. So in production they **fail closed**: both return `403` unless `ALLOW_UNAUTHENTICATED_SESSIONS=true`. Before deploying:

- [ ] **Add auth and rate limiting** where the `TODO`s are (`rejectUnlessSessionsAllowed()` in `lib/server-env.ts`, called by both routes). For example, require your app's signed-in session and limit sessions per user and per IP (your host's firewall, or a store like Upstash/Redis). Only set `ALLOW_UNAUTHENTICATED_SESSIONS=true` if you accept that anyone can start sessions.
- [ ] **Check the [free-tier terms](#free-tier).** For real users, and for any users in the EEA, Switzerland or the UK, use the paid tier: link a billing account to the project, and set a [spend cap / budget](https://aistudio.google.com/docs/billing) on it (use a dedicated project for this app).
- [ ] **Know what is capped server-side** (see [Limits](#limits)): Simli's caps and the Gemini token expiry are enforced by the providers. Check your Simli plan's concurrency and minutes.
- [ ] Set `SIMLI_API_KEY`, `GEMINI_API_KEY` (and optionally `SIMLI_FACE_ID`) in your host's environment settings. Never commit `.env*` files (they are git-ignored, except `.env.example`). Consider [restricting the Gemini key](https://aistudio.google.com/docs/api-key) to the Gemini API.
- [ ] Serve over HTTPS (browsers require it for the microphone).

In production, error responses are generic (details go to the server log). The app also sends `Content-Security-Policy: frame-ancestors 'self'`, `Permissions-Policy: microphone=(self), camera=()`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` (see `next.config.ts`).

Note: the browser holds the session's WebSocket, so it can send its own text and audio to the model, but it can't change the locked model, prompt or voice, and the token can't start a second session. Don't put secrets in the prompt, and keep sensitive actions (tools) on the server.

## Deploy on Vercel

The app deploys to [Vercel](https://vercel.com/new) as a standard Next.js project. Add the environment variables in the project settings and complete the checklist above first.

## Want the agent on a server instead?

This starter runs the voice agent in the browser. For a server-side agent (tools and business logic on your backend, telephony, more control), use Simli with [LiveKit Agents](https://github.com/simliai/create-simli-app-livekit-agents) or [Pipecat](https://github.com/simliai/create-simli-app-pipecat).

## Using a coding agent?

This repo includes the Simli agent skill in `.agents/skills/simli` (also linked at `.claude/skills/simli`), so coding agents (for example Claude Code) know how to use Simli correctly when you change this app. To install it in another project, run:

```bash
npx skills add simliai/skills
```

To check your Simli key and face without starting a session: `python3 .agents/skills/simli/scripts/check_setup.py --env .env.local`.

## Troubleshooting

- **"... is not set on the server"**: create `.env.local` (see Setup) and restart `npm run dev`.
- **403 "Sessions are disabled on this deployment"**: production fails closed; see [Before you deploy](#before-you-deploy).
- **"GEMINI_API_KEY was rejected"**: copy the key again from https://aistudio.google.com/apikey (no quotes or spaces), and check the Gemini API is available in [your region](https://aistudio.google.com/docs/available-regions).
- **"This is usually Gemini's free-tier limit" / close code 1011**: too many Live sessions at once or the quota is used up. Close other tabs running the app, wait a minute, check https://aistudio.google.com/rate-limit, or enable billing.
- **"Gemini refused the session" / close code 1008**: the model id in `app/avatar.ts` isn't available to your key, or the token expired (each one must be used within 60 s).
- **"reached Gemini's session time limit"**: a Live connection lasts about 10 minutes; start a new conversation (see [Limits](#limits)).
- **Avatar doesn't move / no sound**: check the browser console, and that nothing blocks `*.simli.ai` or `generativelanguage.googleapis.com` (VPN, firewall). Start from a click so the browser allows audio.
- **The avatar interrupts itself**: use headphones; the microphone is opened with echo cancellation, but loud speakers can still leak.
- **Too many Simli sessions (429)**: stop other sessions; closed tabs end their session automatically.
- More: https://docs.simli.com, https://aistudio.google.com/docs/live-api and [Discord](https://discord.gg/yQx49zNF4d).
