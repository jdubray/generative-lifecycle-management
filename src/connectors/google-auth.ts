/**
 * @fileoverview Shared Google service-account authentication helper.
 * Imported by both ga4-connector.ts and gsc-connector.ts.
 */

import { GoogleAuth } from "googleapis-common";

/**
 * OAuth2 scopes required by the connectors:
 *  - GA4 Data API v1beta
 *  - Google Search Console API v1
 */
const GOOGLE_SCOPES: string[] = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

/**
 * Constructs and returns a {@link GoogleAuth} instance configured with the
 * service-account key file at `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` and the
 * scopes needed by GA4 + Search Console.
 *
 * The caller is responsible for confirming that the key file exists before
 * invoking this helper (see {@link Ga4Connector} constructor for the
 * ConfigError guard).
 *
 * @returns A GoogleAuth instance ready for use with googleapis clients.
 */
export function getGoogleAuth(): GoogleAuth {
  const keyFile = process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"];
  return new GoogleAuth({
    keyFile,
    scopes: GOOGLE_SCOPES,
  });
}
