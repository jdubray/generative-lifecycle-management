/**
 * @fileoverview GA4 data types and error classes shared across the data-ingestion layer.
 */

/**
 * A single normalised row returned by any GA4 runReport fetch method.
 * Metric values are cast to integers; absent dimensions default to '(not set)'.
 */
export interface Ga4SessionRow {
  /** YYYYMMDD date string from the GA4 date dimension. */
  date: string;
  /** Traffic source (e.g. 'google', 'chatgpt.com'). */
  session_source: string;
  /** Traffic medium (e.g. 'organic', 'cpc', 'referral'). */
  session_medium: string;
  /** GA4 default channel grouping (e.g. 'Organic Search', 'Paid Search'). */
  session_default_channel_group: string;
  /** Paid search keyword; '(not set)' when Google Ads is not linked. */
  session_keyword?: string;
  /** Landing page path for the session. */
  landing_page?: string;
  /** User country derived from IP geo-lookup. */
  country?: string;
  /** Device category: 'desktop' | 'mobile' | 'tablet'. */
  device_category?: string;
  /** Total session count — always a non-negative integer. */
  sessions: number;
  /** Total conversion event count — 0 when no events are configured. */
  conversions: number;
}

/**
 * Thrown when required configuration (env vars, credential files) is absent or
 * unreadable before any network call is attempted.
 */
export class ConfigError extends Error {
  /** @param message Human-readable description of the missing/invalid config. */
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a Google API call returns an HTTP 4xx/5xx or the underlying
 * network request fails.
 */
export class ApiError extends Error {
  /** HTTP status code returned by the API, or 0 for network-level failures. */
  readonly status: number;

  /**
   * @param message  Human-readable description of the failure.
   * @param options  Optional object carrying the HTTP `status` code.
   */
  constructor(message: string, options: { status: number } = { status: 0 }) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
