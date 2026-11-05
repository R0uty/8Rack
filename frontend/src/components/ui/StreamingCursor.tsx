/** Blinking cursor shown at the end of streaming text - one shared implementation (used by the
 * Factory Dashboard's advance stream and woven into string-based streaming transcripts). */
export function StreamingCursor() {
  return <span className="animate-blink ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-primary align-middle" />;
}
