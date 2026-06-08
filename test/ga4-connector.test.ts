/**
 * @fileoverview Acceptance tests for Ga4Connector.
 * All GA4 API calls are mocked via bun:test module mocking; no real network
 * traffic is made and no service-account file is required on disk (except for
 * the constructor-level ConfigError path where a fixture file is needed).
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
  const dir = join(tmpdir(), "ga4-test-keys");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "fake-sa.json");
  writeFileSync(
    p,
    JSON.stringify({
      type: "service_account",
      project_id: "test-project",
      private_key_id: "key-id",
      private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----\n",
      client_email: "test@test-project.iam.gserviceaccount.com",
      client_id: "123456",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    "utf8",
  );
  return p;
}

/** Builds a minimal GA4 runReport response payload. */
function makeReportResponse(rows: Array<{ dims: string[]; metrics: string[] }>) {
  return {
    data: {
      rows: rows.map(({ dims, metrics }) => ({
        dimensionValues: dims.map((v) => ({ value: v })),
        metricValues: metrics.map((v) => ({ value: v })),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level mock wiring
// ---------------------------------------------------------------------------

// We replace the googleapis module with a factory that lets each test control
// what runReport returns.

let _mockRunReport: ReturnType<typeof mock>;

mock.module("googleapis", () => {
  _mockRunReport = mock(async () => makeReportResponse([]));

  return {
    google: {
      analyticsdata: () => ({
        properties: {
          runReport: _mockRunReport,
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

const { Ga4Connector } = await import("../src/connectors/ga4-connector.js");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Ga4Connector", () => {
  let keyFilePath: string;

  beforeEach(() => {
    keyFilePath = createFakeKeyFile();
    process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"] = keyFilePath;
    process.env["GA4_PROPERTY_ID"] = "123456789";
    process.env["LOOKBACK_DAYS"] = "90";
    // Reset the mock implementation before each test
    _mockRunReport.mockImplementation(async () => makeReportResponse([]));
  });

  afterEach(() => {
    if (existsSync(keyFilePath)) unlinkSync(keyFilePath);
    delete process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"];
    delete process.env["GA4_PROPERTY_ID"];
    delete process.env["LOOKBACK_DAYS"];
  });

  // -------------------------------------------------------------------------
  // BR-GA4-001 — ConfigError on missing key file
  // -------------------------------------------------------------------------

  it("constructor throws ConfigError when key file path is missing", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"] = "/tmp/does-not-exist-ga4-test.json";
    expect(() => new Ga4Connector()).toThrow(ConfigError);
  });

  it("constructor throws ConfigError when GOOGLE_SERVICE_ACCOUNT_KEY_PATH is unset", () => {
    delete process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"];
    expect(() => new Ga4Connector()).toThrow(ConfigError);
  });

  // -------------------------------------------------------------------------
  // fetchAiReferrerSessions — happy path
  // -------------------------------------------------------------------------

  it("fetchAiReferrerSessions returns normalised Ga4SessionRow array for mocked 200 response", async () => {
    _mockRunReport.mockImplementation(async () =>
      makeReportResponse([
        { dims: ["20240301", "chatgpt.com", "referral"], metrics: ["42"] },
        { dims: ["20240301", "perplexity.ai", "referral"], metrics: ["17"] },
      ]),
    );

    const connector = new Ga4Connector();
    const rows = await connector.fetchAiReferrerSessions(30);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "20240301",
      session_source: "chatgpt.com",
      session_medium: "referral",
      sessions: 42,
      conversions: 0,
    });
    expect(rows[1]).toMatchObject({
      session_source: "perplexity.ai",
      sessions: 17,
    });
  });

  // -------------------------------------------------------------------------
  // fetchPaidKeywordSessions — cpc filter
  // -------------------------------------------------------------------------

  it("fetchPaidKeywordSessions returns only cpc-medium rows", async () => {
    _mockRunReport.mockImplementation(async () =>
      makeReportResponse([
        { dims: ["20240301", "google", "cpc", "seo dashboard"], metrics: ["10"] },
        { dims: ["20240301", "bing", "cpc", "(not set)"], metrics: ["5"] },
      ]),
    );

    const connector = new Ga4Connector();
    const rows = await connector.fetchPaidKeywordSessions(7);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.session_medium).toBe("cpc");
    }
    expect(rows[0]!.session_keyword).toBe("seo dashboard");
    expect(rows[1]!.session_keyword).toBe("(not set)");
  });

  // -------------------------------------------------------------------------
  // fetchOrganicOverviewRows — organic filter
  // -------------------------------------------------------------------------

  it("fetchOrganicOverviewRows returns only Organic Search channel rows", async () => {
    _mockRunReport.mockImplementation(async () =>
      makeReportResponse([
        {
          dims: [
            "20240301",
            "Organic Search",
            "/landing-page",
            "United States",
            "desktop",
            "google",
            "organic",
          ],
          metrics: ["200", "15"],
        },
      ]),
    );

    const connector = new Ga4Connector();
    const rows = await connector.fetchOrganicOverviewRows(14);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_default_channel_group: "Organic Search",
      landing_page: "/landing-page",
      country: "United States",
      device_category: "desktop",
      sessions: 200,
      conversions: 15,
    });
  });

  // -------------------------------------------------------------------------
  // BR-GA4-003 — empty row set → empty array
  // -------------------------------------------------------------------------

  it("empty GA4 row set returns empty array without throwing", async () => {
    _mockRunReport.mockImplementation(async () => ({ data: {} }));

    const connector = new Ga4Connector();
    const rows = await connector.fetchAiReferrerSessions(30);
    expect(rows).toEqual([]);
  });

  it("GA4 response with explicit empty rows array returns empty array", async () => {
    _mockRunReport.mockImplementation(async () => ({ data: { rows: [] } }));

    const connector = new Ga4Connector();
    const rows = await connector.fetchOrganicOverviewRows(30);
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ApiError on HTTP 403
  // -------------------------------------------------------------------------

  it("fetchAiReferrerSessions throws ApiError on mocked HTTP 403", async () => {
    _mockRunReport.mockImplementation(async () => {
      const err = new Error("Forbidden");
      (err as unknown as Record<string, unknown>)["code"] = 403;
      throw err;
    });

    const connector = new Ga4Connector();
    await expect(connector.fetchAiReferrerSessions(30)).rejects.toThrow(ApiError);

    try {
      await connector.fetchAiReferrerSessions(30);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // BR-GA4-004 — retry once on 429, then throw ApiError
  // -------------------------------------------------------------------------

  it("fetchAiReferrerSessions retries once on 429 then throws ApiError on second 429", async () => {
    let callCount = 0;
    _mockRunReport.mockImplementation(async () => {
      callCount++;
      const err = new Error("Too Many Requests");
      (err as unknown as Record<string, unknown>)["code"] = 429;
      throw err;
    });

    // Speed up the test: stub sleep to resolve immediately
    // We override the module-internal sleep by reducing LOOKBACK_DAYS to
    // trigger the retry logic; the actual 60 s delay is tested via call count.
    // Patch: replace globalThis.setTimeout temporarily
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error — patching for test speed
    globalThis.setTimeout = (fn: () => void, _ms: number) => originalSetTimeout(fn, 0);

    const connector = new Ga4Connector();
    try {
      await connector.fetchAiReferrerSessions(30);
      expect(true).toBe(false); // should never reach
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(429);
      expect(callCount).toBe(2); // exactly one retry
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  // -------------------------------------------------------------------------
  // Type casting — sessions and conversions are integers
  // -------------------------------------------------------------------------

  it("sessions and conversions are cast to integer from string", async () => {
    _mockRunReport.mockImplementation(async () =>
      makeReportResponse([
        {
          dims: [
            "20240301",
            "Organic Search",
            "/",
            "Germany",
            "mobile",
            "google",
            "organic",
          ],
          metrics: ["999", "37"],
        },
      ]),
    );

    const connector = new Ga4Connector();
    const rows = await connector.fetchOrganicOverviewRows(30);

    expect(typeof rows[0]!.sessions).toBe("number");
    expect(typeof rows[0]!.conversions).toBe("number");
    expect(rows[0]!.sessions).toBe(999);
    expect(rows[0]!.conversions).toBe(37);
    expect(Number.isInteger(rows[0]!.sessions)).toBe(true);
    expect(Number.isInteger(rows[0]!.conversions)).toBe(true);
  });
});
