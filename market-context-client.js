// market-context-client.js
export function createMarketContextClient(userConfig) {
  if (!userConfig || !userConfig.url) throw new Error("MarketContextClient: config.url is required");

  const config = {
    url: userConfig.url,
    fetchOptions: userConfig.fetchOptions ?? {},
    staleAfterSeconds: userConfig.staleAfterSeconds ?? null, // null => use snapshot ttl_seconds or 360
    retry: userConfig.retry ?? { enabled: false, maxRetries: 0, delayMs: 250 },
    now: userConfig.now ?? (() => Date.now()),
  };

  // In-memory cached snapshot
  let snapshot = null;

  // Times (ms)
  let fetchedAtMs = null;      // when fetch completed successfully
  let generatedAtMs = null;    // from snapshot.generated_at

  // One fetch per page load: promise memoization
  let initPromise = null;

  // Status + listeners
  let state = "idle";
  let lastError = null;
  const listeners = new Set();

  function emit() {
    const status = getStatus();
    for (const fn of listeners) {
      try { fn(status); } catch (_) {}
    }
  }

  function setState(next, err = null) {
    state = next;
    lastError = err;
    emit();
  }

  function parseIsoToMs(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }

  function validateMarketContextV1(obj) {
    // Minimal validation to avoid brittle coupling.
    // Fail closed on obvious schema mismatch.
    if (!obj || typeof obj !== "object") return { ok: false, code: "schema", message: "Snapshot is not an object" };
    if (typeof obj.schema_version !== "string") return { ok: false, code: "schema", message: "Missing schema_version" };
    if (!Array.isArray(obj.providers)) return { ok: false, code: "schema", message: "Missing providers[]" };
    if (typeof obj.generated_at !== "string") return { ok: false, code: "schema", message: "Missing generated_at" };
    // ttl_seconds optional but expected; don't hard fail if absent
    return { ok: true };
  }

  function effectiveStaleAfterSeconds() {
    if (config.staleAfterSeconds != null) return config.staleAfterSeconds;
    if (snapshot && Number.isFinite(snapshot.ttl_seconds)) return snapshot.ttl_seconds;
    return 360;
  }

  function getSnapshotAgeSeconds(nowMs = config.now()) {
    if (!generatedAtMs) return null;
    const ageSec = (nowMs - generatedAtMs) / 1000;
    return ageSec >= 0 ? ageSec : 0;
  }

  function isStale(nowMs = config.now()) {
    if (!snapshot || !generatedAtMs) return true; // no data => treat as stale for UI purposes
    const age = getSnapshotAgeSeconds(nowMs);
    if (age == null) return true;
    return age > effectiveStaleAfterSeconds();
  }

  function getStatus() {
    const ageSeconds = getSnapshotAgeSeconds();
    const stale = snapshot ? isStale() : null;
    const nextState =
      snapshot
        ? (stale ? "stale" : "ready")
        : (state === "loading" ? "loading" : (state === "unavailable" ? "unavailable" : state));

    return {
      state: nextState,
      error: lastError,
      fetchedAtMs,
      generatedAtMs,
      ageSeconds,
      staleAfterSeconds: snapshot ? effectiveStaleAfterSeconds() : null,
    };
  }

  async function fetchOnce() {
    setState("loading", null);

    let resp;
    try {
      resp = await fetch(config.url, { cache: "no-store", ...config.fetchOptions });
    } catch (e) {
      return { ok: false, code: "network", message: e?.message || "Network error" };
    }

    if (!resp.ok) {
      return { ok: false, code: "http", message: `HTTP ${resp.status}` };
    }

    let json;
    try {
      json = await resp.json();
    } catch (e) {
      return { ok: false, code: "json", message: "Invalid JSON" };
    }

    const v = validateMarketContextV1(json);
    if (!v.ok) return { ok: false, code: v.code, message: v.message };

    const genMs = parseIsoToMs(json.generated_at);
    if (!genMs) return { ok: false, code: "schema", message: "Invalid generated_at" };

    snapshot = json;
    fetchedAtMs = config.now();
    generatedAtMs = genMs;

    // Update state but do not throw for stale; UI can warn.
    setState(isStale() ? "stale" : "ready", null);
    return { ok: true };
  }

  async function init() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const retryEnabled = !!config.retry?.enabled;
      const maxRetries = retryEnabled ? (config.retry.maxRetries ?? 0) : 0;

      let attempt = 0;
      while (true) {
        const res = await fetchOnce();
        if (res.ok) return;

        attempt += 1;
        if (attempt > maxRetries) {
          setState("unavailable", { code: res.code, message: res.message });
          throw Object.assign(new Error(`MarketContext unavailable: ${res.message}`), { code: res.code });
        }

        // single minimal retry
        const delayMs = config.retry.delayMs ?? 250;
        await new Promise(r => setTimeout(r, delayMs));
      }
    })();

    return initPromise;
  }

  function requireSnapshot() {
    if (!snapshot) throw Object.assign(new Error("MarketContext unavailable"), { code: "unavailable" });
    return snapshot;
  }

  function getProviders() {
    const s = requireSnapshot();
    // keep it conservative: expose only what’s needed
    return s.providers.map(p => ({
      id: p.id,
      name: p.name,
      methods: (p.methods ?? []).map(m => ({ id: m.id, type: m.type, label: m.label })),
    }));
  }

  function getMethods(providerId) {
    const s = requireSnapshot();
    const p = (s.providers || []).find(x => x.id === providerId);
    if (!p) return [];
    return (p.methods ?? []).map(m => ({ id: m.id, type: m.type, label: m.label }));
  }

  function getPairData(providerId, methodId, pair) {
    const s = requireSnapshot();
    const p = (s.providers || []).find(x => x.id === providerId);
    if (!p) return null;
    const m = (p.methods ?? []).find(x => x.id === methodId);
    if (!m) return null;

    // Assumption consistent with your v1: pair keyed as "BASE/QUOTE" under method.pairs
    const pairs = m.pairs ?? m.data?.pairs ?? null;
    if (!pairs || typeof pairs !== "object") return null;

    return pairs[pair] ?? null;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getAvailableCurrencies() {
    const s = requireSnapshot();
    const currencies = new Set();

    for (const provider of s.providers || []) {
      for (const method of provider.methods || []) {
        const pairs = method.pairs ?? {};
        for (const pair of Object.keys(pairs)) {
          // Pair format: "BASE/QUOTE"
          const [base, quote] = pair.split('/');
          if (base) currencies.add(base);
          if (quote) currencies.add(quote);
        }
      }
    }

    return Array.from(currencies).sort();
  }

  return {
    init,
    getProviders,
    getMethods,
    getPairData,
    getAvailableCurrencies,
    getSnapshotAgeSeconds,
    isStale,
    getStatus,
    subscribe,
  };
}
