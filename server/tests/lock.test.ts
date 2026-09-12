import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestRedisDb, type TestRedisHandle } from "./redis-test-helper.js";

let testRedis: TestRedisHandle;
let redisModule: typeof import("../src/redis.js");
let lockModule: typeof import("../src/lock.js");

beforeAll(async () => {
  testRedis = await prepareTestRedisDb(4);
  process.env.REDIS_DB = String(testRedis.db);
  redisModule = await import("../src/redis.js");
  await redisModule.connectRedis();
  lockModule = await import("../src/lock.js");
});

afterAll(async () => {
  await redisModule.pubClient.quit();
  await redisModule.subClient.quit();
  await testRedis.flush();
});

describe("acquireLock / releaseLock", () => {
  it("grants the lock when free and blocks a second acquirer until it is released", async () => {
    const key = "lock:test:basic";
    const token = await lockModule.acquireLock(key, { ttlMs: 5000, maxWaitMs: 200 });
    expect(token).toBeTruthy();

    const blocked = await lockModule.acquireLock(key, { maxWaitMs: 100, retryDelayMs: 10 });
    expect(blocked).toBeNull();

    await lockModule.releaseLock(key, token!);

    const afterRelease = await lockModule.acquireLock(key, { maxWaitMs: 200, retryDelayMs: 10 });
    expect(afterRelease).toBeTruthy();
    await lockModule.releaseLock(key, afterRelease!);
  });

  it("does not release a lock held by someone else (CAS on the token)", async () => {
    const key = "lock:test:cas";
    const token = await lockModule.acquireLock(key, { ttlMs: 5000 });
    expect(token).toBeTruthy();

    await lockModule.releaseLock(key, "not-the-real-token");

    const stillBlocked = await lockModule.acquireLock(key, { maxWaitMs: 100, retryDelayMs: 10 });
    expect(stillBlocked).toBeNull();

    await lockModule.releaseLock(key, token!);
  });
});

describe("withLock", () => {
  it("runs the callback and releases the lock afterwards", async () => {
    const key = "lock:test:withlock";
    const result = await lockModule.withLock(key, async () => "done");
    expect(result).toBe("done");

    const token = await lockModule.acquireLock(key, { maxWaitMs: 200, retryDelayMs: 10 });
    expect(token).toBeTruthy();
    await lockModule.releaseLock(key, token!);
  });

  it("releases the lock even when the callback throws", async () => {
    const key = "lock:test:withlock-throw";
    await expect(
      lockModule.withLock(key, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const token = await lockModule.acquireLock(key, { maxWaitMs: 200, retryDelayMs: 10 });
    expect(token).toBeTruthy();
    await lockModule.releaseLock(key, token!);
  });

  it("throws LockTimeoutError when the lock cannot be acquired in time", async () => {
    const key = "lock:test:timeout";
    const holderToken = await lockModule.acquireLock(key, { ttlMs: 5000 });
    expect(holderToken).toBeTruthy();

    await expect(
      lockModule.withLock(key, async () => "unreachable", { maxWaitMs: 100, retryDelayMs: 10 })
    ).rejects.toThrow(lockModule.LockTimeoutError);

    await lockModule.releaseLock(key, holderToken!);
  });

  it("serializes concurrent callers so increments under the lock never race", async () => {
    const key = "lock:test:serialize";
    let counter = 0;
    const increments = Array.from({ length: 20 }, () =>
      lockModule.withLock(
        key,
        async () => {
          const current = counter;
          await new Promise((resolve) => setTimeout(resolve, 1));
          counter = current + 1;
        },
        { maxWaitMs: 5000, retryDelayMs: 5 }
      )
    );
    await Promise.all(increments);
    expect(counter).toBe(20);
  });
});
