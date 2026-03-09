/**
 * QuoteEngine - Core computation for quote results
 * 
 * Two route types:
 * 1. Single-leg P2P (USDT/BOB depth-aware)
 * 2. Two-leg routes (rate-based first leg + P2P second leg, or P2P + rate-based)
 * 
 * All quote results use USDT as the reference currency for effective rate calculations.
 */

/**
 * Normalize and validate an offer from the snapshot.
 */
function validateOffer(offer) {
  return {
    price: Number(offer.price) || 0,
    qtyBase: Number(offer.qty_base) || 0,
    minFiat: Number.isFinite(offer.min_fiat) ? Number(offer.min_fiat) : 0,
    maxFiat: Number.isFinite(offer.max_fiat) ? Number(offer.max_fiat) : Infinity,
    verified: Boolean((offer.flags || {}).verified),
  };
}

/**
 * Filter and sort offers for a given direction.
 * direction: 'BS_TO_USDT' (sell BS, get USDT) or 'USDT_TO_BS' (sell USDT, get BS)
 * Uses snapshot.sell[] for BS_TO_USDT (asks), snapshot.buy[] for USDT_TO_BS (bids).
 */
function prepareOffers(snapshot, direction, verifiedOnly = false) {
  const buy = Array.isArray(snapshot.buy) ? snapshot.buy : [];
  const sell = Array.isArray(snapshot.sell) ? snapshot.sell : [];

  // BS_TO_USDT: we sell BS, so we take asks (sell[])
  // USDT_TO_BS: we sell USDT, so we take bids (buy[])
  const offerSide = direction === 'BS_TO_USDT' ? sell : buy;

  if (!offerSide.length) return [];

  // Sort: for BS_TO_USDT (buys), prefer lowest price. For USDT_TO_BS (sells), prefer highest price.
  const sortDesc = direction === 'USDT_TO_BS';

  return offerSide
    .map(validateOffer)
    .filter((o) => Number.isFinite(o.price) && o.price > 0 && Number.isFinite(o.qtyBase) && o.qtyBase > 0)
    .filter((o) => !verifiedOnly || o.verified)
    .sort((a, b) => (sortDesc ? b.price - a.price : a.price - b.price));
}

/**
 * Select a single best offer for singleOfferOnly mode.
 * Balances: price rank (70%) + liquidity rank (30%).
 */
function selectBestOffer(offers, direction) {
  if (!offers.length) return null;

  // Calculate fillable amount for each offer
  const scored = offers.map((offer, idx) => {
    let fillable = 0;
    if (direction === 'BS_TO_USDT') {
      const maxFiatByQty = offer.qtyBase * offer.price;
      const maxFiat = Math.min(offer.maxFiat, maxFiatByQty);
      fillable = maxFiat;
    } else {
      const maxUsdtByMaxFiat = Number.isFinite(offer.maxFiat)
        ? offer.maxFiat / offer.price
        : Infinity;
      const maxUsdt = Math.min(offer.qtyBase, maxUsdtByMaxFiat);
      fillable = maxUsdt * offer.price; // Convert back to fiat for comparison
    }
    return { idx, offer, fillable };
  });

  const maxFillable = Math.max(...scored.map((s) => s.fillable));

  let bestIdx = 0;
  let bestScore = Infinity;

  for (const { idx, fillable } of scored) {
    const priceRank = idx; // Lower is better (already sorted by price)
    const liquidityRank = maxFillable > 0
      ? ((maxFillable - fillable) / maxFillable) * offers.length
      : offers.length;

    // Weight: 70% price, 30% liquidity
    const score = priceRank * 0.7 + liquidityRank * 0.3;

    if (score < bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }

  return offers[bestIdx];
}

/**
 * Simulate depth-aware filling for P2P (1-leg).
 * - direction: 'BS_TO_USDT' or 'USDT_TO_BS'
 * - amount: amount in the source currency
 * - offers: sorted, filtered offer list
 * - singleOfferOnly: use only the best single offer
 * 
 * Returns: { output, offersConsumed, selectedOffers, partialFill, remainingAmount }
 */
function simulateDepthFill(amount, offers, direction, singleOfferOnly = false) {
  if (!offers.length) {
    return {
      output: 0,
      offersConsumed: 0,
      selectedOffers: [],
      partialFill: true,
      remainingAmount: amount,
    };
  }

  const offersToUse = singleOfferOnly ? [selectBestOffer(offers, direction)] : offers;

  let remaining = amount;
  let output = 0;
  let offersConsumed = 0;
  const selectedOffers = [];

  for (const offer of offersToUse) {
    if (remaining <= 0) break;

    if (direction === 'BS_TO_USDT') {
      // Selling Bs., buying USDT
      const maxFiatByQty = offer.qtyBase * offer.price;
      const maxFiat = Math.min(offer.maxFiat, maxFiatByQty);

      if (maxFiat <= 0 || remaining < offer.minFiat) continue;

      const takeFiat = Math.min(remaining, maxFiat);
      if (takeFiat < offer.minFiat) continue;

      const isMaxed = takeFiat === maxFiat;
      const takeUsdt = takeFiat / offer.price;

      output += takeUsdt;
      remaining -= takeFiat;
      offersConsumed += 1;
      selectedOffers.push({
        price: offer.price,
        amountTaken: takeFiat,
        unit: 'Bs.',
        isMaxed,
      });
    } else {
      // Selling USDT, buying Bs.
      const maxUsdtByMaxFiat = Number.isFinite(offer.maxFiat)
        ? offer.maxFiat / offer.price
        : Infinity;
      const maxUsdt = Math.min(offer.qtyBase, maxUsdtByMaxFiat);

      if (maxUsdt <= 0) continue;

      const minUsdt = offer.minFiat > 0 ? offer.minFiat / offer.price : 0;
      if (maxUsdt * offer.price < offer.minFiat) continue;

      const takeUsdt = Math.min(remaining, maxUsdt);
      if (takeUsdt < minUsdt) continue;

      const isMaxed = takeUsdt === maxUsdt;
      const takeFiat = takeUsdt * offer.price;

      output += takeFiat;
      remaining -= takeUsdt;
      offersConsumed += 1;
      selectedOffers.push({
        price: offer.price,
        amountTaken: takeUsdt,
        unit: 'USDT',
        isMaxed,
      });
    }
  }

  return {
    output,
    offersConsumed,
    selectedOffers,
    partialFill: remaining > 0.000001,
    remainingAmount: Math.max(0, remaining),
  };
}

/**
 * Rate-based conversion (no depth, single quoted rate).
 * Used for Convert or Spot methods.
 */
function convertAtRate(amount, rate) {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return {
    output: amount * rate,
    offersConsumed: 1,
    selectedOffers: [{ price: rate, amountTaken: amount, unit: 'rate', isMaxed: false }],
    partialFill: false,
    remainingAmount: 0,
  };
}

/**
 * Quote for a single-leg P2P route (USDT/BOB).
 */
function quote1LegP2P(snapshot, amount, direction, options = {}) {
  const { verifiedOnly = false, singleOfferOnly = false } = options;

  const offers = prepareOffers(snapshot, direction, verifiedOnly);
  if (!offers.length) return null;

  const fill = simulateDepthFill(amount, offers, direction, singleOfferOnly);

  const filledAmount = amount - fill.remainingAmount;
  const effectiveRate =
    filledAmount > 0
      ? direction === 'BS_TO_USDT'
        ? filledAmount / fill.output
        : fill.output / filledAmount
      : null;

  return {
    outputAmount: fill.output,
    effectiveRate,
    offersConsumed: fill.offersConsumed,
    partialFill: fill.partialFill,
    remainingAmount: fill.remainingAmount,
    remainingCurrency: direction === 'BS_TO_USDT' ? 'USDT' : 'Bs.',
    selectedOffers: fill.selectedOffers,
    snapshotTtlSeconds: snapshot.ttl_seconds ?? null,
    routeLegs: 1,
    routeDescription: 'Binance P2P (depth-aware)',
  };
}

/**
 * Quote for a two-leg route: rate-based (leg 1) + P2P (leg 2).
 * Example: CLP -> USDT (at rate) -> BOB (via P2P)
 * 
 * leg1Rate: conversion rate for first leg
 * leg1From, leg1To: currency codes for first leg
 * leg2From, leg2To: currency codes for second leg
 * leg2Direction: 'BS_TO_USDT' or 'USDT_TO_BS' for the P2P snapshot
 */
function quote2LegRateP2P(
  snapshot,
  amount,
  leg1Rate,
  leg1From,
  leg1To,
  leg2Direction,
  options = {}
) {
  const { verifiedOnly = false, singleOfferOnly = false } = options;

  if (!Number.isFinite(leg1Rate) || leg1Rate <= 0) return null;

  // Leg 1: rate-based conversion
  const leg1Output = amount * leg1Rate;

  // Leg 2: P2P depth-aware
  const offers = prepareOffers(snapshot, leg2Direction, verifiedOnly);
  if (!offers.length) return null;

  const leg2Fill = simulateDepthFill(leg1Output, offers, leg2Direction, singleOfferOnly);

  const totalInput = amount;
  const totalOutput = leg2Fill.output;

  // Effective rate: how much output you get per input unit
  const effectiveRate = totalInput > 0 ? totalOutput / totalInput : null;

  return {
    outputAmount: totalOutput,
    effectiveRate,
    offersConsumed: leg2Fill.offersConsumed,
    partialFill: leg2Fill.partialFill,
    remainingAmount: leg2Fill.remainingAmount,
    remainingCurrency: leg2Direction === 'BS_TO_USDT' ? 'USDT' : 'Bs.',
    selectedOffers: leg2Fill.selectedOffers,
    snapshotTtlSeconds: snapshot.ttl_seconds ?? null,
    routeLegs: 2,
    routeDescription: `${leg1From} -> ${leg1To} (${leg1Rate.toFixed(4)}) -> ${leg2Direction === 'BS_TO_USDT' ? 'USDT' : 'Bs.'}`,
    leg1Amount: amount,
    leg1Rate,
    leg1Output,
  };
}

/**
 * Quote for a two-leg route: P2P (leg 1) + rate-based (leg 2).
 * Example: BOB -> USDT (via P2P) -> CLP (at rate)
 */
function quote2LegP2PRate(
  snapshot,
  amount,
  leg1Direction,
  leg2Rate,
  leg1From,
  leg1To,
  leg2To,
  options = {}
) {
  const { verifiedOnly = false, singleOfferOnly = false } = options;

  if (!Number.isFinite(leg2Rate) || leg2Rate <= 0) return null;

  // Leg 1: P2P depth-aware
  const offers = prepareOffers(snapshot, leg1Direction, verifiedOnly);
  if (!offers.length) return null;

  const leg1Fill = simulateDepthFill(amount, offers, leg1Direction, singleOfferOnly);

  // Leg 2: rate-based conversion
  const leg2Output = leg1Fill.output * leg2Rate;

  const totalInput = amount;
  const totalOutput = leg2Output;

  const effectiveRate = totalInput > 0 ? totalOutput / totalInput : null;

  return {
    outputAmount: totalOutput,
    effectiveRate,
    offersConsumed: leg1Fill.offersConsumed,
    partialFill: leg1Fill.partialFill,
    remainingAmount: leg1Fill.remainingAmount,
    remainingCurrency: leg1To,
    selectedOffers: leg1Fill.selectedOffers,
    snapshotTtlSeconds: snapshot.ttl_seconds ?? null,
    routeLegs: 2,
    routeDescription: `${leg1From} -> ${leg1To} (depth) -> ${leg2To} (${leg2Rate.toFixed(4)})`,
    leg1Amount: amount,
    leg1Output: leg1Fill.output,
    leg2Rate,
    leg2Output,
  };
}

export const QuoteEngine = {
  /**
   * Main quote function.
   * 
   * For single-currency pairs (USDT/BOB):
   *   quote({ snapshot, amount, direction: 'BS_TO_USDT' | 'USDT_TO_BS', ... })
   * 
   * For two-leg routes (multi-currency):
   *   quote({ snapshot, amount, route: 'RATE_THEN_P2P', leg1Rate, ... })
   *   quote({ snapshot, amount, route: 'P2P_THEN_RATE', leg2Rate, ... })
   */
  quote(params) {
    const {
      snapshot,
      amount,
      direction = null,
      route = null,
      verifiedOnly = false,
      singleOfferOnly = false,
      // Two-leg specific
      leg1Rate = null,
      leg1From = null,
      leg1To = null,
      leg2Direction = null,
      leg2Rate = null,
      leg1Direction = null,
      leg2To = null,
    } = params;

    if (!snapshot || !Number.isFinite(amount) || amount <= 0) return null;

    let quoteResult = null;

    // Single-leg route (default for backward compatibility)
    if (!route && direction) {
      if (direction !== 'BS_TO_USDT' && direction !== 'USDT_TO_BS') return null;
      quoteResult = quote1LegP2P(snapshot, amount, direction, {
        verifiedOnly,
        singleOfferOnly,
      });
    }
    // Two-leg: rate then P2P (e.g., CLP -> USDT -> BOB)
    else if (route === 'RATE_THEN_P2P') {
      if (!leg1Rate || !leg1From || !leg1To || !leg2Direction) return null;
      quoteResult = quote2LegRateP2P(
        snapshot,
        amount,
        leg1Rate,
        leg1From,
        leg1To,
        leg2Direction,
        { verifiedOnly, singleOfferOnly }
      );
    }
    // Two-leg: P2P then rate (e.g., BOB -> USDT -> CLP)
    else if (route === 'P2P_THEN_RATE') {
      if (!leg1Direction || !leg2Rate || !leg1From || !leg1To || !leg2To) return null;
      quoteResult = quote2LegP2PRate(
        snapshot,
        amount,
        leg1Direction,
        leg2Rate,
        leg1From,
        leg1To,
        leg2To,
        { verifiedOnly, singleOfferOnly }
      );
    }

    // Enrich with UI-friendly fields
    return enrichQuoteForUI(quoteResult);
  },
};

/**
 * Format offers for UI display (as HTML strings).
 */
function formatOffersForUI(selectedOffers) {
  return selectedOffers.map((offer) => {
    const priceStr = formatNumber(offer.price, 3);
    const amountStr = formatNumber(offer.amountTaken, 2);
    const base = `Bs. ${priceStr} · ${amountStr} ${offer.unit}`;
    return offer.isMaxed
      ? `${base} <span style="color: var(--accent);">Límite máximo</span>`
      : base;
  });
}

// Utility for formatting
function formatNumber(value, decimals = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(decimals) : '--';
}

/**
 * Add UI-friendly fields to a quote result.
 * Enhances the result with topOffers (formatted HTML strings) and otherQuotes placeholder.
 */
function enrichQuoteForUI(quoteResult) {
  if (!quoteResult) return null;
  return {
    ...quoteResult,
    topOffers: formatOffersForUI(quoteResult.selectedOffers || []),
    otherQuotes: [], // Placeholder for future expansion
  };
}
