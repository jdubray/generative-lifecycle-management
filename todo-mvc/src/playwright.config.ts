import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3041);
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB = "./data/todomvc.test.db";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: `bun run src/server.ts`,
    url: `${BASE_URL}/healthz`,
    timeout: 30_000,
    reuseExistingServer: false,
    cwd: ".",
    env: {
      SERVER_PORT: String(PORT),
      DATABASE_PATH: TEST_DB,
      REQUEST_LOGGING: "false",
    },
    stdout: "ignore",
    stderr: "pipe",
  },
});
