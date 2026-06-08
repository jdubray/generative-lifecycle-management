/**
 * @fileoverview GSC data types for the data-ingestion layer.
 * Consumed by gsc-connector.ts and the metrics_cache write path.
 */

/**
 * A single normalised row returned by {@link GscConnector.fetchQueryPerformance}.
 * Represents aggregate click, impression, CTR, and average-position data for one
 * query+page pair over a contiguous date range.
 */
export interface GscQueryRow {
  /** The search query string as reported by the Search Console API. */
  query: string;
  /**
   * Full URL of the ranked page (e.g. `https://example.com/blog/post`).
   * Corresponds to the `page` dimension in the GSC `searchanalytics.query` request.
   */
  page: string;
  /** Total clicks for the query+page pair over the date range. Non-negative integer. */
  clicks: number;
  /** Total impressions for the query+page pair over the date range. Non-negative integer. */
  impressions: number;
  /**
   * Click-through rate as a fraction in [0, 1].
   * Computed by the GSC API as `clicks / impressions`.
   */
  ctr: number;
  /**
   * Average search result position over the date range.
   * Always >= 1. Rounded to exactly 1 decimal place per BR-GSC-002.
   */
  avg_position: number;
  /** ISO-8601 date string (`YYYY-MM-DD`) marking the start of the aggregation period. */
  date_range_start: string;
  /** ISO-8601 date string (`YYYY-MM-DD`) marking the end of the aggregation period. */
  date_range_end: string;
}
