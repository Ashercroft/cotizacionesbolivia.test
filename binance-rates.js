/**
 * Multi-source conversion rate fetcher.
 *
 * Order:
 * 1) Same-origin API endpoint (if configured in production)
 * 2) Binance Spot public ticker (for supported symbols)
 * 3) CoinGecko USDT cross rates (broad fiat coverage + browser CORS-safe)
 */

const INTERNAL_RATE_API_URL = "/api/rates/convert";
const BINANCE_SPOT_URL = "https://api.binance.com/api/v3/ticker/price";
const COINGECKO_USDT_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";

const FIAT_CODES = new Set(["USD", "EUR", "ARS", "BRL", "CNY", "CLP", "PEN"]);
let coinGeckoCache = null;
let coinGeckoCacheAt = 0;
const COINGECKO_CACHE_TTL_MS = 45_000;

function normalizeCurrency(code) {
  return String(code || "").toUpperCase().trim();
}

function isValidRate(rate) {
  return Number.isFinite(rate) && rate > 0;
}

function withTimeout(signalMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), signalMs);
  return { controller, timeoutId };
}

async function fetchInternalRate(fromAsset, toAsset, timeoutMs = 3000) {
  try {
    const params = new URLSearchParams({ from: fromAsset, to: toAsset });
    const { controller, timeoutId } = withTimeout(timeoutMs);
    const resp = await fetch(`${INTERNAL_RATE_API_URL}?${params}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeoutId);

    if (!resp.ok) return null;
    const data = await resp.json();
    const rate = Number.parseFloat(data?.rate);
    return isValidRate(rate) ? rate : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch a rate from Binance Spot ticker as fallback.
 * Assumes symbol is formed as `${fromAsset}${toAsset}` (e.g., CLYUSDT, BRLUSDT).
 * @param {string} fromAsset - Source currency
 * @param {string} toAsset - Target currency
 * @param {number} [timeoutMs=3000] - Request timeout
 * @returns {Promise<number|null>} - Rate or null on failure
 */
export async function fetchBinanceSpotRate(fromAsset, toAsset, timeoutMs = 3000) {
  fromAsset = normalizeCurrency(fromAsset);
  toAsset = normalizeCurrency(toAsset);

  if (!fromAsset || !toAsset) return null;

  const symbol = `${fromAsset}${toAsset}`;

  try {
    const { controller, timeoutId } = withTimeout(timeoutMs);

    const resp = await fetch(`${BINANCE_SPOT_URL}?symbol=${symbol}`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) return null;

    const data = await resp.json();
    const price = parseFloat(data?.price);
    return isValidRate(price) ? price : null;
  } catch (_) {
    return null;
  }
}

async function fetchCoinGeckoUsdtQuotes(timeoutMs = 3000) {
  const now = Date.now();
  if (coinGeckoCache && now - coinGeckoCacheAt < COINGECKO_CACHE_TTL_MS) {
    return coinGeckoCache;
  }

  try {
    const params = new URLSearchParams({
      ids: "tether",
      vs_currencies: "usd,eur,ars,brl,cny,clp,pen",
    });

    const { controller, timeoutId } = withTimeout(timeoutMs);
    const resp = await fetch(`${COINGECKO_USDT_PRICE_URL}?${params}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeoutId);

    if (!resp.ok) return null;
    const data = await resp.json();
    const quotes = data?.tether ?? null;
    if (!quotes || typeof quotes !== "object") return null;

    coinGeckoCache = quotes;
    coinGeckoCacheAt = now;
    return quotes;
  } catch (_) {
    return null;
  }
}

async function fetchCoinGeckoRate(fromAsset, toAsset, timeoutMs = 3000) {
  fromAsset = normalizeCurrency(fromAsset);
  toAsset = normalizeCurrency(toAsset);

  if (fromAsset === toAsset) return 1;

  const quotes = await fetchCoinGeckoUsdtQuotes(timeoutMs);
  if (!quotes) return null;

  const usdtTo = (code) => {
    if (code === "USDT" || code === "USD") return 1;
    if (!FIAT_CODES.has(code)) return null;
    const value = Number.parseFloat(quotes[code.toLowerCase()]);
    return isValidRate(value) ? value : null;
  };

  const fromInUsdt = fromAsset === "USDT" ? 1 : null;
  const toInFiat = usdtTo(toAsset);

  if (fromInUsdt && toInFiat) return toInFiat;

  const fromUsdtPrice = usdtTo(fromAsset);
  if (fromUsdtPrice && toAsset === "USDT") return 1 / fromUsdtPrice;

  if (fromUsdtPrice && toInFiat) return toInFiat / fromUsdtPrice;

  return null;
}

/**
 * Fetch a conversion rate, trying Convert API first, then Spot API as fallback.
 * @param {string} fromAsset - Source currency
 * @param {string} toAsset - Target currency
 * @param {number} [timeoutMs=3000] - Request timeout per attempt
 * @returns {Promise<number|null>} - Rate or null if both fail
 */
export async function fetchConversionRate(fromAsset, toAsset, timeoutMs = 3000) {
  fromAsset = normalizeCurrency(fromAsset);
  toAsset = normalizeCurrency(toAsset);

  if (!fromAsset || !toAsset) return null;
  if (fromAsset === toAsset) return 1;

  let rate = await fetchInternalRate(fromAsset, toAsset, timeoutMs);
  if (rate) return rate;

  rate = await fetchBinanceSpotRate(fromAsset, toAsset, timeoutMs);
  if (rate) return rate;

  return fetchCoinGeckoRate(fromAsset, toAsset, timeoutMs);
}

/**
 * Fetch multiple conversion rates in parallel.
 * @param {Array<[string, string]>} pairs - Array of [fromAsset, toAsset] tuples
 * @param {number} [timeoutMs=3000] - Timeout per request
 * @returns {Promise<Object>} - Object mapping "FROM/TO" to rate (null if failed)
 */
export async function fetchMultipleRates(pairs, timeoutMs = 3000) {
  const promises = pairs.map(async ([from, to]) => {
    const rate = await fetchConversionRate(from, to, timeoutMs);
    return { pair: `${normalizeCurrency(from)}/${normalizeCurrency(to)}`, rate };
  });

  const results = await Promise.all(promises);
  const output = {};

  for (const { pair, rate } of results) {
    output[pair] = rate;
  }

  return output;
}
