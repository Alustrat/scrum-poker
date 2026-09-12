import { randomUUID } from "node:crypto";
import { pubClient } from "./redis.js";
import { settings } from "./settings.js";

// CAS delete: only the holder that set the token may release the lock, so a
// lock that outlives its holder (e.g. a slow request past the TTL) can never
// be released out from under whoever re-acquired it in the meantime.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Timed out waiting for lock: ${key}`);
    this.name = "LockTimeoutError";
  }
}

export interface LockOptions {
  ttlMs?: number;
  retryDelayMs?: number;
  maxWaitMs?: number;
}

export async function acquireLock(
  key: string,
  { ttlMs = settings.lock.ttlMs, retryDelayMs = 25, maxWaitMs = settings.lock.maxWaitMs }: LockOptions = {}
): Promise<string | null> {
  const token = randomUUID();
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const acquired = await pubClient.set(key, token, { NX: true, PX: ttlMs });
    if (acquired) return token;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

export async function releaseLock(key: string, token: string): Promise<void> {
  await pubClient.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
}

// Runs `fn` while holding a distributed lock on `key`, so the check-then-act
// sequences inside it (e.g. "count participants, then add one") are atomic
// across every server instance instead of racing on concurrent requests.
export async function withLock<T>(key: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  const token = await acquireLock(key, options);
  if (!token) {
    throw new LockTimeoutError(key);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(key, token);
  }
}
