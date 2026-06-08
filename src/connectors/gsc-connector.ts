/**
 * @fileoverview Google Search Console API v3 connector.
 * Owns: API call construction, JWT acquisition via google-auth helper,
 * raw GSC ApiDataRow → GscQueryRow normalisation.
 * Does NOT own: JWT key loading (shared google-auth helper); SQLite writes
 * (owned by metrics_cache); GA4 API calls (owned by ga4_connector).
 */

import { google } from "googleapis";
import { existsSync } from "node:fs";
import { getGoogleAuth } from "./google-auth.js";
import { ApiError, ConfigError } from "../types/ga4.js";
import type { GscQueryRow } from "../types/gsc.js";

/**
 * Hard-coded GSC API row limit per BR-GSC-001.
 * The Search Console API silently truncates results beyond this value.
 * Acceptable for v1 of the dashboard.
 */
const ROW_LIMIT = 25_000;

/** Milliseconds to wait before the single retry on HTTP 429. */
const QUOTA_RETRY_DELAY_MS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SearchConsoleClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryResponse = any;

/**
 * Raw row shape returned by the GSC `searchanalytics.query` endpoint.
 * `keys` entries correspond to the requested dimensions in order: [query, page].
 * @internal
 */
interface RawGscRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

/**
 * Pauses execution for `ms` milliseconds.
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a `{ startDate, endDate }` pair in `YYYY-MM-DD` format for the GSC API.
 *
 * @param lookbackDays Number of days before today to begin the range (inclusive).
 * @returns Object with `startDate` and `endDate` ISO-8601 date strings.
 */
function buildDateRange(lookbackDays: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - lookbackDays);

  const fmt = (d: Date): string => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * Normalises a single raw GSC API row into a {@link GscQueryRow}.
 * BR-GSC-002: `avg_position` is always rounded to 1 decimal place via
 * `Math.round(position * 10) / 10`.
 *
 * @param raw            Raw row object from `searchanalytics.query` response.
 * @param dateRangeStart ISO-8601 start date string for the aggregation period.
 * @param dateRangeEnd   ISO-8601 end date string for the aggregation period.
 * @returns Normalised {@link GscQueryRow}.
 */
function normaliseRow(
  raw: RawGscRow,
  dateRangeStart: string,
  dateRangeEnd: string,
): GscQueryRow {
  const keys = raw.keys ?? [];
  return {
    query: keys[0] ?? "",
    page: keys[1] ?? "",
    clicks: raw.clicks ?? 0,
    impressions: raw.impressions ?? 0,
    ctr: raw.ctr ?? 0,
    // BR-GSC-002: round to exactly 1 decimal place
    avg_position: Math.round((raw.position ?? 1) * 10) / 10,
    date_range_start: dateRangeStart,
    date_range_end: dateRangeEnd,
  };
}

/**
 * Wraps the Google Search Console API v3 (`webmasters`) and exposes
 * {@link fetchQueryPerformance} for use by the metrics_cache sync layer.
 *
 * **Construction** validates that `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` resolves to
 * a readable file and that `GSC_SITE_URL` is set; throws {@link ConfigError}
 * synchronously before any network call is made (BR-GSC-004).
 *
 * @example
 * ```ts
 * const connector = new GscConnector();
 * const rows = await connector.fetchQueryPerformance(28);
 * ```
 */
export class GscConnector {
  private readonly _client: SearchConsoleClient;
  private readonly _siteUrl: string;

  constructor() {
    // Validate credentials file synchronously before any network I/O (BR-GSC-004)
    const keyPath = process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"];
    if (!keyPath || !existsSync(keyPath)) {
      throw new ConfigError(
        `GOOGLE_SERVICE_ACCOUNT_KEY_PATH not found: "${keyPath ?? "(unset)"}"`,
      );
    }

    const siteUrl = process.env["GSC_SITE_URL"];
    if (!siteUrl) {
      throw new ConfigError("GSC_SITE_URL environment variable is not set");
    }

    this._siteUrl = siteUrl;
    const auth = getGoogleAuth();
    this._client = google.webmasters({ version: "v3", auth });
  }

  /**
   * Fetches query performance data from Google Search Console for the given
   * lookback window. Calls `searchanalytics.query` with `dimensions=[query, page]`,
   * `rowLimit=25000` (BR-GSC-001, hard-coded — the GSC API silently truncates
   * beyond this value), and a date range of `lookbackDays` days ending today.
   * Returns data aggregated over the full period (no daily breakdown).
   *
   * @param lookbackDays Number of days to look back. Must be >= 1.
   * @returns Array of normalised {@link GscQueryRow}; empty array if no data (BR-GSC-003).
   * @throws {ConfigError} If `GSC_SITE_URL` or `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`
   *   are missing — thrown synchronously from the constructor (BR-GSC-004).
   * @throws {ApiError} On HTTP 4xx/5xx from the GSC API. Retries once on HTTP 429
   *   after a 60 s delay; throws on second failure.
   */
  async fetchQueryPerformance(lookbackDays: number): Promise<GscQueryRow[]> {
    const { startDate, endDate } = buildDateRange(lookbackDays);

    const response = await this._runWithRetry(() =>
      this._client.searchanalytics.query({
        siteUrl: this._siteUrl,
        requestBody: {
          startDate,
          endDate,
          dimensions: ["query", "page"],
          // BR-GSC-001: rowLimit is always exactly 25000; the GSC API hard limit.
          rowLimit: ROW_LIMIT,
        },
      }),
    );

    // BR-GSC-003: empty result set MUST return empty array, not throw
    const rows: unknown[] = response?.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return [];

    return rows.map((raw) => normaliseRow(raw as RawGscRow, startDate, endDate));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Executes a GSC API call and retries once on HTTP 429 after a fixed delay.
   *
   * Error taxonomy:
   * - HTTP 403 → {@link ApiError}(`'GSC permission denied'`, `{ status: 403 }`)
   * - HTTP 429 (first attempt) → waits `QUOTA_RETRY_DELAY_MS` then retries once
   * - HTTP 429 (second attempt) → {@link ApiError}(`'GSC quota exceeded'`, `{ status: 429 }`)
   * - Other errors → {@link ApiError} with extracted status
   *
   * @param fn Async factory that performs the API call.
   * @returns The successful API response data payload.
   * @throws {ApiError} On 403, on second 429, or on any other HTTP/network error.
   */
  private async _runWithRetry(fn: () => Promise<QueryResponse>): Promise<QueryResponse> {
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
          throw new ApiError("GSC permission denied", { status: 403 });
        }
        if (status === 429) {
          throw new ApiError("GSC quota exceeded", { status: 429 });
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(`GSC request failed: ${message}`, { status });
      }
    }
    // Unreachable; TypeScript requires a terminal return path.
    throw new ApiError("GSC request failed after retry", { status: 0 });
  }

  /**
   * Extracts the HTTP status code from a googleapis error object.
   * googleapis sets `error.code` for HTTP status codes on most errors.
   *
   * @param err Unknown caught value.
   * @returns HTTP status integer, or `0` if unavailable.
   */
  private _extractStatus(err: unknown): number {
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e["code"] === "number") return e["code"];
      if (typeof e["status"] === "number") return e["status"];
    }
    return 0;
  }
}
