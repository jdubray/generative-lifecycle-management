/**
 * @fileoverview Acceptance tests for GscConnector.
 * All GSC API calls are mocked via bun:test module mocking; no real network
 * traffic is made and no valid service-account file is required on disk (except
 * for the constructor-level ConfigError path where a fixture file is needed).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError, ConfigError } from "../src/types/ga4.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Writes a minimal fake service-account JSON file and returns its path. */
function createFakeKeyFile(): string {
  const dir = join(tmpdir(), "gsc-test-keys");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "fake-sa.json");
  writeFileSync(
    p,
    JSON.stringify({
      type: "service_account",
      project_id: "test-project",
      private_key_id: "key-id",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----\n",
      client_email: "test@test-project.iam.gserviceaccount.com",
      client_id: "123456",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    "utf8",
  );
  return p;
}

/** Builds a minimal GSC searchanalytics.query response payload. */
function makeQueryResponse(
  rows: Array<{
    query: string;
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>,
) {
  return {
    data: {
      rows: rows.map(({ query, page, clicks, impressions, ctr, position }) => ({
        keys: [query, page],
        clicks,
        impressions,
        ctr,
        position,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level mock wiring
// ---------------------------------------------------------------------------

// Replace googleapis with a controllable factory. A wrapper around
// _mockSearchanalyticsQuery captures each outbound request into _lastCallArgs
// so tests can assert on what was sent to the API.

let _mockSearchanalyticsQuery: ReturnType<typeof mock>;
let _lastCallArgs: unknown;

mock.module("googleapis", () => {
  _mockSearchanalyticsQuery = mock(async () => makeQueryResponse([]));

  return {
    google: {
      webmasters: () => ({
        searchanalytics: {
          query: (args: unknown) => {
            _lastCallArgs = args;
            return _mockSearchanalyticsQuery(args);
          },
        },
      }),
    },
  };
});

mock.module("googleapis-common", () => ({
  GoogleAuth: class {
    constructor(_opts: unknown) {}
  },
}));

// ---------------------------------------------------------------------------
// Import the connector AFTER mocks are registered so it picks up the mocked
// googleapis module.
// ---------------------------------------------------------------------------

const { GscConnector } = await import("../src/connectors/gsc-connector.js");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GscConnector", () => {
  let keyFilePath: string;

  beforeEach(() => {
    keyFilePath = createFakeKeyFile();
    process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"] = keyFilePath;
    process.env["GSC_SITE_URL"] = "https://example.com/";
    _lastCallArgs = undefined;
    _mockSearchanalyticsQuery.mockImplementation(async () => makeQueryResponse([]));
  });

  afterEach(() => {
    if (existsSync(keyFilePath)) unlinkSync(keyFilePath);
    delete process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"];
    delete process.env["GSC_SITE_URL"];
  });

  // -------------------------------------------------------------------------
  // fetchQueryPerformance — happy path
  // -------------------------------------------------------------------------

  it("fetchQueryPerformance returns normalised GscQueryRow array for mocked 200 response", async () => {
    _mockSearchanalyticsQuery.mockImplementation(async () =>
      makeQueryResponse([
        {
          query: "seo dashboard tool",
          page: "https://example.com/seo",
          clicks: 120,
          impressions: 3000,
          ctr: 0.04,
          position: 4.3,
        },
        {
          query: "aeo answer engine optimisation",
          page: "https://example.com/aeo",
          clicks: 55,
          impressions: 1200,
          ctr: 0.046,
          position: 7.8,
        },
      ]),
    );

    const connector = new GscConnector();
    const rows = await connector.fetchQueryPerformance(30);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      query: "seo dashboard tool",
      page: "https://example.com/seo",
      clicks: 120,
      impressions: 3000,
      ctr: 0.04,
      avg_position: 4.3,
    });
    expect(rows[1]).toMatchObject({
      query: "aeo answer engine optimisation",
      page: "https://example.com/aeo",
      clicks: 55,
      avg_position: 7.8,
    });
    // date_range fields must be ISO-8601 YYYY-MM-DD strings
    expect(rows[0]!.date_range_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0]!.date_range_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // date_range_start must be before date_range_end
    expect(rows[0]!.date_range_start < rows[0]!.date_range_end).toBe(true);
  });

  // -------------------------------------------------------------------------
  // BR-GSC-002 — avg_position rounded to 1 decimal place
  // -------------------------------------------------------------------------

  it("avg_position is rounded to 1 decimal place", async () => {
    _mockSearchanalyticsQuery.mockImplementation(async () =>
      makeQueryResponse([
        // 4.36 → Math.round(43.6) / 10 = 44 / 10 = 4.4
        {
          query: "rounds up",
          page: "https://example.com/a",
          clicks: 1,
          impressions: 10,
          ctr: 0.1,
          position: 4.36,
        },
        // 7.14 → Math.round(71.4) / 10 = 71 / 10 = 7.1
        {
          query: "rounds down",
          page: "https://example.com/b",
          clicks: 2,
          impressions: 20,
          ctr: 0.1,
          position: 7.14,
        },
        // 1.0 → Math.round(10) / 10 = 1.0 (exact, no rounding needed)
        {
          query: "exact minimum",
          page: "https://example.com/c",
          clicks: 3,
          impressions: 30,
          ctr: 0.1,
          position: 1.0,
        },
      ]),
    );

    const connector = new GscConnector();
    const rows = await connector.fetchQueryPerformance(7);

    expect(rows[0]!.avg_position).toBe(4.4);
    expect(rows[1]!.avg_position).toBe(7.1);
    expect(rows[2]!.avg_position).toBe(1.0);
  });

  // -------------------------------------------------------------------------
  // BR-GSC-003 — empty row set → empty array (must not throw)
  // -------------------------------------------------------------------------

  it("empty GSC row set returns empty array without throwing", async () => {
    _mockSearchanalyticsQuery.mockImplementation(async () => ({ data: {} }));

    const connector = new GscConnector();
    const rows = await connector.fetchQueryPerformance(30);
    expect(rows).toEqual([]);
  });

  it("GSC response with explicit empty rows array returns empty array", async () => {
    _mockSearchanalyticsQuery.mockImplementation(async () => ({ data: { rows: [] } }));

    const connector = new GscConnector();
    const rows = await connector.fetchQueryPerformance(30);
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // BR-GSC-004 — ConfigError propagates when credentials are missing
  // -------------------------------------------------------------------------

  it("ConfigError propagates from google-auth when key file missing", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"] = "/tmp/does-not-exist-gsc-test.json";
    expect(() => new GscConnector()).toThrow(ConfigError);
  });

  it("constructor throws ConfigError when GOOGLE_SERVICE_ACCOUNT_KEY_PATH is unset", () => {
    delete process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"];
    expect(() => new GscConnector()).toThrow(ConfigError);
  });

  it("constructor throws ConfigError when GSC_SITE_URL is unset", () => {
    delete process.env["GSC_SITE_URL"];
    expect(() => new GscConnector()).toThrow(ConfigError);
  });

  // -------------------------------------------------------------------------
  // ApiError on HTTP 403
  // -------------------------------------------------------------------------

  it("throws ApiError on mocked HTTP 403", async () => {
    _mockSearchanalyticsQuery.mockImplementation(async () => {
      const err = new Error("Forbidden");
      (err as unknown as Record<string, unknown>)["code"] = 403;
      throw err;
    });

    const connector = new GscConnector();
    await expect(connector.fetchQueryPerformance(30)).rejects.toThrow(ApiError);

    // Verify status code is propagated correctly
    try {
      await connector.fetchQueryPerformance(30);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // Retry once on 429 then throw ApiError
  // -------------------------------------------------------------------------

  it("retries once on 429 then throws ApiError", async () => {
    let callCount = 0;
    _mockSearchanalyticsQuery.mockImplementation(async () => {
      callCount++;
      const err = new Error("Too Many Requests");
      (err as unknown as Record<string, unknown>)["code"] = 429;
      throw err;
    });

    // Stub globalThis.setTimeout so the 60 s retry delay resolves immediately
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error — patching for test speed
    globalThis.setTimeout = (fn: () => void, _ms: number) => originalSetTimeout(fn, 0);

    const connector = new GscConnector();
    try {
      await connector.fetchQueryPerformance(30);
      expect(true).toBe(false); // unreachable — fetchQueryPerformance must throw
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(429);
      // Must have called the API exactly twice (original + one retry)
      expect(callCount).toBe(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  // -------------------------------------------------------------------------
  // BR-GSC-001 — rowLimit is always 25000 in the outbound request
  // -------------------------------------------------------------------------

  it("rowLimit is always 25000 in the outbound request", async () => {
    const connector = new GscConnector();
    await connector.fetchQueryPerformance(30);

    const req = _lastCallArgs as {
      siteUrl: string;
      requestBody: { rowLimit: number; dimensions: string[] };
    };
    expect(req).toBeDefined();
    expect(req.requestBody.rowLimit).toBe(25_000);
  });

  it("dimensions include both query and page in the outbound request", async () => {
    const connector = new GscConnector();
    await connector.fetchQueryPerformance(14);

    const req = _lastCallArgs as {
      requestBody: { dimensions: string[] };
    };
    expect(req.requestBody.dimensions).toEqual(["query", "page"]);
  });
});
