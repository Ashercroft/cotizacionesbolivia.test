/**
 * Intent Logger - Client-side user intent tracking
 * 
 * Logs only user intent (not execution or identity):
 * - From / to currencies
 * - Nominal input amount  
 * - Provider and method selected
 * - UI mode (normal / advanced)
 * 
 * Features:
 * - Client-side rate limiting (max 1 per 20s)
 * - Conditional logging (only if bucket changes)
 * - Server-side validation and USDT normalization
 */

export function createIntentLogger(userConfig) {
  if (!userConfig || !userConfig.url) {
    throw new Error("IntentLogger: config.url is required");
  }

  const config = {
    url: userConfig.url,
    fetchOptions: userConfig.fetchOptions ?? {},
    rateLimitMs: userConfig.rateLimitMs ?? 20000, // 1 per 20 seconds
    onlyNewBuckets: userConfig.onlyNewBuckets ?? true, // only log if bucket changes
    enabled: userConfig.enabled ?? true, // can be disabled globally
  };

  let lastLogTimeMs = null;
  let lastBucket = null;
  let requestInFlight = false;

  /**
   * Map amount to USDT-equivalent bucket (matching server logic).
   * Used to determine if intent should be logged (only on bucket change).
   */
  function estimateBucket(amount, fromCurrency) {
    // Rough USDT rates for bucketing
    const rates = {
      BOB: 1 / 6.9,    // ~0.145
      BRL: 0.195,
      CNY: 0.138,
      ARS: 0.0105,
      PEN: 0.267,
      CLP: 0.00113,
      EUR: 1.09,
      USDT: 1.0,
    };

    const rate = rates[fromCurrency] || 1;
    const usdt = amount * rate;

    // Buckets
    const buckets = [
      { low: 0, high: 50 },
      { low: 50, high: 100 },
      { low: 100, high: 250 },
      { low: 250, high: 500 },
      { low: 500, high: 1000 },
      { low: 1000, high: 2500 },
      { low: 2500, high: 5000 },
      { low: 5000, high: 10000 },
      { low: 10000, high: Infinity },
    ];

    for (const b of buckets) {
      if (usdt >= b.low && usdt < b.high) {
        return b.high === Infinity ? `${b.low}+` : `${b.low}-${b.high}`;
      }
    }
    return "invalid";
  }

  /**
   * Check if enough time has passed since last log.
   */
  function isRateLimitActive() {
    if (!lastLogTimeMs) return false;
    return Date.now() - lastLogTimeMs < config.rateLimitMs;
  }

  /**
   * Check if bucket has changed (indicating meaningful user intent change).
   */
  function hasBucketChanged(bucket) {
    return lastBucket !== bucket;
  }

  /**
   * Log an intent event.
   * 
   * @param {Object} intent - Intent data
   * @param {string} intent.from - From currency (e.g., "BOB")
   * @param {string} intent.to - To currency (e.g., "USDT")
   * @param {number} intent.amount - Amount in source currency
   * @param {string} intent.provider - Provider ID (e.g., "binance")
   * @param {string} intent.method - Method ID (e.g., "p2p")
   * @param {string} [intent.uiMode] - UI mode ("normal" or "advanced")
   */
  async function log(intent) {
    if (!config.enabled) return { ok: false, reason: "disabled" };

    // Validate
    if (!intent.from || !intent.to || !intent.amount || !intent.provider || !intent.method) {
      return { ok: false, reason: "missing_fields" };
    }

    // Check rate limit
    if (isRateLimitActive()) {
      return { ok: false, reason: "rate_limited" };
    }

    // Check bucket change (if enabled)
    const bucket = estimateBucket(intent.amount, intent.from);
    if (config.onlyNewBuckets && !hasBucketChanged(bucket)) {
      return { ok: false, reason: "same_bucket" };
    }

    // Prevent concurrent requests
    if (requestInFlight) {
      return { ok: false, reason: "request_in_flight" };
    }

    // Send to server
    requestInFlight = true;
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...config.fetchOptions?.headers,
        },
        body: JSON.stringify({
          from: intent.from,
          to: intent.to,
          amount: intent.amount,
          provider: intent.provider,
          method: intent.method,
          ui_mode: intent.uiMode || "normal",
        }),
        ...config.fetchOptions,
      });

      if (response.ok) {
        const data = await response.json();
        if (data.logged) {
          // Update tracking only on successful server processing
          lastLogTimeMs = Date.now();
          lastBucket = bucket;
          return { ok: true };
        } else {
          // Server dropped (rate limit or other)
          return { ok: false, reason: "dropped_by_server" };
        }
      } else {
        return { ok: false, reason: `http_${response.status}` };
      }
    } catch (error) {
      return { ok: false, reason: error?.message || "network_error" };
    } finally {
      requestInFlight = false;
    }
  }

  /**
   * Get seconds until next log is allowed.
   */
  function getSecondsUntilNextLog() {
    if (!lastLogTimeMs) return 0;
    const elapsed = Date.now() - lastLogTimeMs;
    const remaining = Math.max(0, config.rateLimitMs - elapsed);
    return Math.ceil(remaining / 1000);
  }

  return {
    log,
    getSecondsUntilNextLog,
    isRateLimitActive,
  };
}
