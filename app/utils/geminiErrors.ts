/**
 * Turns a Gemini Live API WebSocket close (code + reason) into a message a developer can act on.
 * The Live API reports most failures by closing the socket; the reason text is Google's.
 * https://aistudio.google.com/docs/live-api/session-management
 * https://aistudio.google.com/docs/rate-limits
 */
export function explainGeminiClose(code: number, reason: string): string {
  const why = reason ? `: ${reason}` : "";
  const r = reason.toLowerCase();

  const quota =
    r.includes("quota") ||
    r.includes("resource_exhausted") ||
    r.includes("resource exhausted") ||
    r.includes("rate limit") ||
    r.includes("too many") ||
    r.includes("concurrent");
  if (quota || code === 1011) {
    return (
      `Gemini closed the session (code ${code})${why}. ` +
      "This is usually Gemini's free-tier limit: too many sessions at once, or the per-minute/per-day quota is used up. " +
      "Close other sessions, wait a minute and try again, or check your limits at https://aistudio.google.com/rate-limit " +
      "(a paid tier raises them)."
    );
  }
  if (code === 1008) {
    return (
      `Gemini refused the session (code ${code})${why}. ` +
      "The session token may have expired or been used already (each token starts one session within 60 s), " +
      "or the model isn't available to this key: check gemini_model in app/avatar.ts and GEMINI_API_KEY."
    );
  }
  if (code === 1007) {
    return `Gemini rejected the session setup (code ${code})${why}. Check the model and voice in app/avatar.ts.`;
  }
  if (code === 1006) {
    return "Lost the connection to Gemini (network, VPN or firewall blocking generativelanguage.googleapis.com?).";
  }
  return `Gemini ended the conversation (code ${code})${why}.`;
}
