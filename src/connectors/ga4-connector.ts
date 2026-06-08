/**
 * @fileoverview GA4 Data API v1beta connector.
 * Owns: API call construction, JWT acquisition via google-auth helper,
 * raw dimensionValue/metricValue → Ga4SessionRow normalisation.
 * Does NOT own: SQLite writes, sync scheduling, GSC API calls.
 */

import { google } from "googleapis";
import { existsSync } from "node:fs";
import { getGoogleAuth } from "./google-auth.js";
import { ApiError, ConfigError, type Ga4SessionRow } from "../types/ga4.js";

/** Milliseconds to wait before the single retry on HTTP 429. */
const QUOTA_RETRY_DELAY_MS = 60_000;

/** Fallback system maximum for lookback days (matches LOOKBACK_DAYS env var). */
const DEFAULT_MAX_LOOKBACK = 90;

/**
 * Reads the LOOKBACK_DAYS environment variable and returns its numeric value,
 * falling back to {@link DEFAULT_MAX_LOOKBACK} if unset or invalid.
 */
function getMaxLookbackDays(): number {
  const raw = process.env["LOOKBACK_DAYS"];
  if (!raw) return DEFAULT_MAX_LOOKBACK;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LOOKBACK;
}

/**
 * Clamps `lookbackDays` to [1, LOOKBACK_DAYS system param] per BR-GA4-002.
 */
function clampLookback(lookbackDays: number): number {
  const max = getMaxLookbackDays();
  return Math.max(1, Math.min(lookbackDays, max));
}

/**
 * Builds an ISO-8601 date-range string pair understood by the GA4 runReport API.
 * @param lookbackDays Number of days before today to include.
 * @returns Object with `startDate` and `endDate` strings in `YYYY-MM-DD` format.
 */
function buildDateRange(lookbackDays: number): { startDate: string; endDate: string } {
  return {
    startDate: `${lookbackDays}daysAgo`,
    endDate: "today",
  };
}

/** @internal Dimension value helper — returns '(not set)' for absent values. */
function dimValue(row: gapi.client.analyticsdata.v1beta.DimensionValue | undefined): string {
  return row?.value ?? "(not set)";
}

/** @internal Metric value helper — returns 0 for absent/non-numeric values. */
function metricInt(row: gapi.client.analyticsdata.v1beta.MetricValue | undefined): number {
  const v = parseInt(row?.value ?? "0", 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

// ---------------------------------------------------------------------------
// Type aliases for the googleapis analyticsdata response shapes
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunReportResponse = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnalyticsDataClient = any;

/**
 * Pauses execution for `ms` milliseconds.
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Ga4Connector
// ---------------------------------------------------------------------------

/**
 * Wraps the GA4 Data API v1beta and exposes three typed fetch methods used by
 * the metrics_cache sync layer.
 *
 * **Construction** validates that `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` resolves to
 * a readable file; throws {@link ConfigError} synchronously before any network
 * call is made (BR-GA4-001).
 *
 * @example
 * ```ts
 * const connector = new Ga4Connector();
 * const rows = await connector.fetchAiReferrerSessions(30);
 * ```
 */
export class Ga4Connector {
  private readonly _client: AnalyticsDataClient;
  private readonly _propertyId: string;

  constructor() {
    // BR-GA4-001: validate credentials file synchronously before any network I/O
    const keyPath = process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"];
    if (!keyPath || !existsSync(keyPath)) {
      throw new ConfigError(
        `GOOGLE_SERVICE_ACCOUNT_KEY_PATH not found: "${keyPath ?? "(unset)"}"`,
      );
    }

    const propertyId = process.env["GA4_PROPERTY_ID"];
    if (!propertyId) {
      throw new ConfigError("GA4_PROPERTY_ID environment variable is not set");
    }

    this._propertyId = propertyId;
    const auth = getGoogleAuth();
    this._client = google.analyticsdata({ version: "v1beta", auth });
  }

  // -------------------------------------------------------------------------
  // Public fetch methods
  // -------------------------------------------------------------------------

  /**
   * Fetches session data grouped by `sessionSource` for the given lookback
   * window. Returns **all** sources; the caller filters to AI-referrer domains.
   *
   * @param lookbackDays Number of days to look back (capped at `LOOKBACK_DAYS`).
   * @returns Array of {@link Ga4SessionRow}; empty array when GA4 has no data.
   * @throws {@link ConfigError} if credentials are missing (caught in constructor).
   * @throws {@link ApiError} on HTTP 4xx/5xx after optional retry.
   */
  async fetchAiReferrerSessions(lookbackDays: number): Promise<Ga4SessionRow[]> {
    const days = clampLookback(lookbackDays);
    const request = {
      property: `properties/${this._propertyId}`,
      requestBody: {
        dateRanges: [buildDateRange(days)],
        dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }],
      },
    };
    const response = await this._runWithRetry(() =>
      this._client.properties.runReport(request),
    );
    return this._normaliseRows(response, {
      dateIdx: 0,
      sessionSourceIdx: 1,
      sessionMediumIdx: 2,
      sessionsMetricIdx: 0,
    });
  }

  /**
   * Fetches paid-search session data (medium = 'cpc') with keyword breakdown.
   *
   * @param lookbackDays Number of days to look back (capped at `LOOKBACK_DAYS`).
   * @returns Array of {@link Ga4SessionRow} where every row has `session_medium === 'cpc'`.
   * @throws {@link ApiError} on HTTP 4xx/5xx after optional retry.
   */
  async fetchPaidKeywordSessions(lookbackDays: number): Promise<Ga4SessionRow[]> {
    const days = clampLookback(lookbackDays);
    const request = {
      property: `properties/${this._propertyId}`,
      requestBody: {
        dateRanges: [buildDateRange(days)],
        dimensions: [
          { name: "date" },
          { name: "sessionSource" },
          { name: "sessionMedium" },
          { name: "sessionKeyword" },
        ],
        metrics: [{ name: "sessions" }],
        dimensionFilter: {
          filter: {
            fieldName: "sessionMedium",
            stringFilter: { matchType: "EXACT", value: "cpc" },
          },
        },
      },
    };
    const response = await this._runWithRetry(() =>
      this._client.properties.runReport(request),
    );
    return this._normaliseRows(response, {
      dateIdx: 0,
      sessionSourceIdx: 1,
      sessionMediumIdx: 2,
      sessionKeywordIdx: 3,
      sessionsMetricIdx: 0,
    });
  }

  /**
   * Fetches organic-search session data with landing page, country, and
   * device breakdowns; includes conversion counts.
   *
   * @param lookbackDays Number of days to look back (capped at `LOOKBACK_DAYS`).
   * @returns Array of {@link Ga4SessionRow} where every row has
   *   `session_default_channel_group === 'Organic Search'`.
   * @throws {@link ApiError} on HTTP 4xx/5xx after optional retry.
   */
  async fetchOrganicOverviewRows(lookbackDays: number): Promise<Ga4SessionRow[]> {
    const days = clampLookback(lookbackDays);
    const request = {
      property: `properties/${this._propertyId}`,
      requestBody: {
        dateRanges: [buildDateRange(days)],
        dimensions: [
          { name: "date" },
          { name: "sessionDefaultChannelGroup" },
          { name: "landingPage" },
          { name: "country" },
          { name: "deviceCategory" },
          { name: "sessionSource" },
          { name: "sessionMedium" },
        ],
        metrics: [{ name: "sessions" }, { name: "conversions" }],
        dimensionFilter: {
          filter: {
            fieldName: "sessionDefaultChannelGroup",
            stringFilter: { matchType: "EXACT", value: "Organic Search" },
          },
        },
      },
    };
    const response = await this._runWithRetry(() =>
      this._client.properties.runReport(request),
    );
    return this._normaliseRows(response, {
      dateIdx: 0,
      sessionDefaultChannelGroupIdx: 1,
      landingPageIdx: 2,
      countryIdx: 3,
      deviceCategoryIdx: 4,
      sessionSourceIdx: 5,
      sessionMediumIdx: 6,
      sessionsMetricIdx: 0,
      conversionsMetricIdx: 1,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Executes a GA4 API call and retries once on HTTP 429 after a fixed delay.
   * BR-GA4-004: waits exactly 60 000 ms before the single retry.
   *
   * @param fn Async factory that performs the API call.
   * @returns The successful API response data.
   * @throws {@link ApiError} on 403, on second 429, or on network failure.
   */
  private async _runWithRetry(fn: () => Promise<RunReportResponse>): Promise<RunReportResponse> {
    let attempt = 0;
    while (attempt < 2) {
      try {
        const res = await fn();
        return res.data;
      } catch (err: unknown) {
        const status = this._extractStatus(err);
        if (status === 429 && attempt === 0) {
          attempt++;
          await sleep(QUOTA_RETRY_DELAY_MS);
          continue;
        }
        if (status === 403) {
          throw new ApiError("GA4 permission denied", { status: 403 });
        }
        if (status === 429) {
          throw new ApiError("GA4 quota exceeded", { status: 429 });
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(`GA4 request failed: ${message}`, { status });
      }
    }
    // Should never reach here; TypeScript needs a return path.
    throw new ApiError("GA4 request failed after retry", { status: 0 });
  }

  /**
   * Extracts the HTTP status code from a googleapis error object.
   * @param err Unknown caught value.
   * @returns HTTP status integer, or 0 if unavailable.
   */
  private _extractStatus(err: unknown): number {
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e["code"] === "number") return e["code"];
      if (typeof e["status"] === "number") return e["status"];
    }
    return 0;
  }

  /**
   * Maps raw GA4 runReport rows to {@link Ga4SessionRow} objects.
   * BR-GA4-003: returns an empty array when the API returns no rows.
   *
   * @param data      Raw API response body.
   * @param mapping   Column-index map describing which dimension/metric lives where.
   * @returns Normalised array of {@link Ga4SessionRow}.
   */
  private _normaliseRows(
    data: RunReportResponse,
    mapping: {
      dateIdx?: number;
      sessionSourceIdx?: number;
      sessionMediumIdx?: number;
      sessionDefaultChannelGroupIdx?: number;
      sessionKeywordIdx?: number;
      landingPageIdx?: number;
      countryIdx?: number;
      deviceCategoryIdx?: number;
      sessionsMetricIdx?: number;
      conversionsMetricIdx?: number;
    },
  ): Ga4SessionRow[] {
    const rows: unknown[] = data?.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return [];

    return rows.map((raw) => {
      const r = raw as {
        dimensionValues?: Array<{ value?: string }>;
        metricValues?: Array<{ value?: string }>;
      };
      const dims = r.dimensionValues ?? [];
      const mets = r.metricValues ?? [];

      const get = (idx: number | undefined, arr: Array<{ value?: string }>): string =>
        idx !== undefined && arr[idx] !== undefined ? (arr[idx]!.value ?? "(not set)") : "(not set)";

      const row: Ga4SessionRow = {
        date: get(mapping.dateIdx, dims),
        session_source: get(mapping.sessionSourceIdx, dims),
        session_medium: get(mapping.sessionMediumIdx, dims),
        session_default_channel_group: get(mapping.sessionDefaultChannelGroupIdx, dims),
        sessions: metricInt(
          mapping.sessionsMetricIdx !== undefined ? mets[mapping.sessionsMetricIdx] : undefined,
        ),
        conversions: metricInt(
          mapping.conversionsMetricIdx !== undefined ? mets[mapping.conversionsMetricIdx] : undefined,
        ),
      };

      if (mapping.sessionKeywordIdx !== undefined)
        row.session_keyword = get(mapping.sessionKeywordIdx, dims);
      if (mapping.landingPageIdx !== undefined)
        row.landing_page = get(mapping.landingPageIdx, dims);
      if (mapping.countryIdx !== undefined)
        row.country = get(mapping.countryIdx, dims);
      if (mapping.deviceCategoryIdx !== undefined)
        row.device_category = get(mapping.deviceCategoryIdx, dims);

      return row;
    });
  }
}
