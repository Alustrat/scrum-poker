import { pubClient } from "../redis.js";

// Fixed-window counter: INCR is atomic on its own, so no lock is needed here
// the way the hard room-count cap in roomService needs one.
export async function incrementFixedWindow(key: string, windowMs: number): Promise<number> {
  const count = await pubClient.incr(key);
  if (count === 1) {
    await pubClient.pExpire(key, windowMs);
  }
  return count;
}
