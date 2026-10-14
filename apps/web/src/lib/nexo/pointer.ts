/**
 * One pointer listener for however many avatars are on screen.
 *
 * Every Nexo avatar that follows the cursor needs the same two numbers, and a
 * `mousemove` handler each would mean N handlers plus N layout reads per
 * event. This keeps a single listener, coalesces bursts into one
 * `requestAnimationFrame`, and fans the result out to subscribers.
 *
 * Subscribers are called with viewport coordinates and are expected to do
 * their own measuring — which is why tracking is opt-in per avatar.
 */
type PointerSubscriber = (x: number, y: number) => void;

const subscribers = new Set<PointerSubscriber>();
let lastX = 0;
let lastY = 0;
let frame: number | null = null;
let listening = false;

function flush(): void {
  frame = null;
  for (const subscriber of subscribers) subscriber(lastX, lastY);
}

function onPointerMove(event: PointerEvent): void {
  lastX = event.clientX;
  lastY = event.clientY;
  if (frame === null) frame = requestAnimationFrame(flush);
}

/**
 * Follow the pointer until the returned function is called. Safe to call from
 * an effect; a no-op outside the browser.
 */
export function subscribeToPointer(subscriber: PointerSubscriber): () => void {
  if (typeof window === "undefined") return () => {};
  subscribers.add(subscriber);
  if (!listening) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    listening = true;
  }
  // A subscriber that mounts after the pointer last moved would otherwise sit
  // cross-eyed until the next twitch.
  subscriber(lastX, lastY);

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && listening) {
      window.removeEventListener("pointermove", onPointerMove);
      listening = false;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    }
  };
}
