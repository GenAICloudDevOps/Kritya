import { Text, useAnimation } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Milliseconds between frames — the spinner's twelve-frames-a-second beat. */
const FRAME_INTERVAL_MS = 80;

/**
 * The spinner that turns beside the working… label. Ink drives this from one
 * animation timer shared by the whole app — no private `setInterval` to own or
 * clean up, and the beat comes from elapsed time, so a busy machine skips a
 * frame instead of drifting late.
 */
export function Spinner({ label }: { label: string }) {
  const { frame } = useAnimation({ interval: FRAME_INTERVAL_MS });
  // `frame` counts up forever; the glyph list is what wraps it back around.
  return (
    <Text color="yellow">
      {FRAMES[frame % FRAMES.length]} <Text dimColor>{label}</Text>
    </Text>
  );
}
