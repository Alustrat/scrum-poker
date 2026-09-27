import { defineConfig } from "vitest/config";
import codspeedPlugin from "@codspeed/vitest-plugin";

// Benchmarks run against in-memory fakes of Redis and Postgres (see
// bench/fakes.ts), so unlike the test config there is no globalSetup that
// requires live services.
export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    environment: "node",
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
