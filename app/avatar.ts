import "server-only";

/**
 * Customize your avatar here.
 *
 * This file is server-only: the API routes read it when they mint session
 * tokens, and the Gemini token is locked to this model, voice and prompt, so the
 * browser can't change them. Only `name` is passed to the page for display.
 *
 * The avatar's face is set with SIMLI_FACE_ID in .env.local (default: Simli's
 * default Trinity-2 face, a woman, so the voice is a female one). If you change
 * the face, change the name and voice to match.
 */
export const avatar = {
  name: "Assistant",

  // Gemini Live API model (native audio in, native audio out).
  // "gemini-3.8-live" is Google's default Live model for voice agents, and it is
  // free of charge on the free tier (a Google AI Studio key, no billing account).
  // Model: https://aistudio.google.com/docs/models/gemini-3.8-live
  // Pricing and free tier: https://aistudio.google.com/docs/pricing#gemini-3.8-live
  gemini_model: "gemini-3.8-live",

  // Prebuilt Gemini voices: https://aistudio.google.com/docs/speech-generation#voices
  // (listen to them at https://aistudio.google.com/live). Two to start with:
  //   Female: "Sulafat" (warm), "Leda" (youthful), "Despina" (smooth)
  //   Male: "Achird" (friendly), "Enceladus" (breathy)
  // Match the voice to the face: the default face is a woman, so Sulafat.
  gemini_voice: "Sulafat",

  initialPrompt:
    "You are a helpful AI assistant, shown to the user as a video avatar. " +
    "You are friendly and concise. Your answers are short and to the point: this is a spoken conversation, " +
    "so never use lists, markdown or long explanations. " +
    "When the conversation starts, greet the user in one short sentence and ask how you can help.",
} as const;

export type AvatarConfig = typeof avatar;
