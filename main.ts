// Patient dip-and-hold bot with a trailing harvest, for the BTC 24h
// bars race (agent-fun/bars-replay/v1).
//
// A full-size round trip costs roughly 0.3-0.4% in fees, slippage and
// impact, and one-minute bars mostly wiggle by less than that, so a bot
// that trades every wiggle pays the pool for nothing: on the published
// dev window the churny crossover style loses heavily while simply
// holding makes money. This bot trades rarely, buys weakness instead
// of chasing strength, and - new in this version - harvests a move
// once it has run, instead of giving it all back: over a full day the
// tape usually offers the same few tenths of a percent several times,
// and taking them one by one compounds.
//
//   - Entry: it watches the first close it sees as its reference and
//     buys once the close offers a 0.2% discount under it, a dip about
//     the size of the round trip's cost. If no dip has come by bar
//     240 it buys then anyway, so a window that only climbs is still
//     ridden; either way it stays out while the tape is in free fall
//     (60-bar change under -1%). One position, sized to the cash on
//     hand under the weight cap.
//   - Harvest exits, in two tiers: at +0.9% a 40% slice is banked;
//     the rest rides until, past a +1.8% peak, it falls 0.9% under it,
//     value; a close back through that line sells the whole position
//     and banks the move. A run that never fades is never sold early:
//     the trail only follows the peak up.
//   - Disaster exits, unchanged: the position worth 6% less than its
//     cost, or the close 3% under its 60-bar exponential average.
//     Anything shallower that is not a harvest is ridden out, and a
//     position still held at the end is sold by the replay's own
//     close.
//   - Re-entry after a harvest: quick - a fresh 0.2% dip under the
//     recent high once 10 bars have passed, still vetoed in free
//     fall. After a disaster exit: only once the close is back within
//     0.5% under the average and the 60-bar change is no longer
//     negative, and never sooner than 30 bars after the exit.
//
// Everything runs in float64 on + - * / and bigint comparisons on the
// money, so two runs over the same bars send the same orders.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** The trend line: an EMA of the closes over this many bars. */
const TREND_SPAN = 60;
/** The rate of change is read over the same span. */
const ROC_BARS = 60;
/** The discount under the first close that counts as a dip worth buying. */
const DIP = 0.002;
/** Buy by this bar even if no dip came, unless the tape is in free fall. */
const FALLBACK_BAR = 240;
/** No entry while the 60-bar change is under -1%: free fall. */
const CRASH_VETO = -0.01;
/** A re-entry wants the 60-bar change back at or above -0.1%. */
const REENTRY_ROC = -0.001;
/** A re-entry wants the close no more than 0.5% under the trend line. */
const REENTRY_BAND = 0.005;
/** Exit once the position is worth 6% less than its cost. */
const HARD_STOP = 0.06;
/** Exit once the close is 3% under the trend line. */
const BREAK_BAND = 0.03;
/** The gain over cost that arms the trailing harvest line. */
const HARVEST_ARM = 0.018;
/** The trailing harvest line sits this far under the peak value. */
const HARVEST_TRAIL = 0.009;
/** First harvest tier: at this gain, a slice of the position is banked. */
const TIER1_ARM = 0.009;
/** A harvest re-entry wants a fresh dip this deep under the recent high. */
const REENTRY_DIP = 0.002;
/** Bars to sit out after a harvest exit. */
const COOLDOWN_HARVEST = 30;
/** Bars to sit out after a disaster exit. */
const COOLDOWN_BARS = 30;
/** No fill may land more than 1.5% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 150;
/** Closes kept per symbol: the trend seed plus the ROC lookback, with slack. */
const HISTORY = 180;

interface Track {
  /** The last HISTORY closes, oldest first. */
  closes: number[];
  /** Closes collected while the average seeds itself. */
  seed: number[];
  /** The trend line after the latest close, or null while it seeds. */
  ema: number | null;
  /** The first close seen: the reference the dip is measured from. */
  firstClose: number | null;
  /** Bars seen for this symbol, the current one included. */
  bars: number;
  /** Bars left before a new entry is allowed. */
  cooldown: number;
  /** The cooldown to apply when the current position is seen closed. */
  pendingCooldown: number;
  /** The best value-to-cost ratio of the current position so far. */
  peakRatio: number;
  /** Whether the first harvest tier already banked its slice. */
  tier1Done: boolean;
  /** Whether the last exit was a harvest (quick re-entry) or not. */
  lastExitHarvest: boolean;
  /** Whether the last batch held a position in this symbol. */
  wasHeld: boolean;
  /** Whether this run has ever held the symbol (first entry vs re-entry). */
  heldBefore: boolean;
}

const tracks = new Map<string, Track>();

function track(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [], seed: [], ema: null, firstClose: null, bars: 0, cooldown: 0, pendingCooldown: COOLDOWN_BARS, peakRatio: 0, tier1Done: false, lastExitHarvest: false, wasHeld: false, heldBefore: false };
    tracks.set(symbol, t);
  }
  return t;
}

/** Fold one bar into its symbol's track: seed the average with the mean of its first span of closes, then move 2 / (span + 1) of the way to each new close. */
function push(t: Track, bar: Bar): void {
  const c = Number(bar.c);
  if (t.firstClose === null) t.firstClose = c;
  t.bars++;
  if (t.ema !== null) t.ema += (2 / (TREND_SPAN + 1)) * (c - t.ema);
  else {
    t.seed.push(c);
    if (t.seed.length === TREND_SPAN) t.ema = t.seed.reduce((a, x) => a + x, 0) / TREND_SPAN;
  }
  t.closes.push(c);
  if (t.closes.length > HISTORY) t.closes.shift();
  if (t.cooldown > 0) t.cooldown--;
}

/** The 60-bar rate of change of the close, or null until enough closes are in. */
function roc(t: Track): number | null {
  if (t.closes.length <= ROC_BARS) return null;
  const then = t.closes[t.closes.length - 1 - ROC_BARS]!;
  const now = t.closes[t.closes.length - 1]!;
  return then === 0 ? null : now / then - 1;
}

/** The highest close in the kept history, the harvest re-entry's reference. */
function recentHigh(t: Track): number {
  let hi = 0;
  for (const c of t.closes) if (c > hi) hi = c;
  return hi;
}

/** Whether the entry rules hold on this close. */
function enters(t: Track): boolean {
  if (t.cooldown > 0) return false;
  const r = roc(t);
  if (r !== null && r < CRASH_VETO) return false;
  const close = t.closes[t.closes.length - 1]!;
  if (!t.heldBefore) {
    if (t.firstClose === null) return false;
    return close <= t.firstClose * (1 - DIP) || t.bars >= FALLBACK_BAR;
  }
  if (t.lastExitHarvest) {
    return close <= recentHigh(t) * (1 - REENTRY_DIP);
  }
  if (t.ema === null) return false;
  return r !== null && r >= REENTRY_ROC && close >= t.ema * (1 - REENTRY_BAND);
}

/** Why a held position exits on this close: 'harvest', 'disaster', or null. The peak ratio is folded in first. */
function exitKind(state: BarsState, symbol: string, t: Track, held: { qty: bigint; cost: bigint }): 'tier1' | 'harvest' | 'disaster' | null {
  const value = state.value(symbol, held.qty);
  const ratio = held.cost === 0n ? 0 : Number(value) / Number(held.cost);
  if (ratio > t.peakRatio) t.peakRatio = ratio;
  if (value * 100n <= held.cost * BigInt(100 - HARD_STOP * 100)) return 'disaster';
  const close = state.close(symbol);
  if (close !== null && t.ema !== null && Number(close) <= t.ema * (1 - BREAK_BAND)) return 'disaster';
  if (!t.tier1Done && ratio >= 1 + TIER1_ARM) return 'tier1';
  if (t.peakRatio >= 1 + HARVEST_ARM && ratio <= t.peakRatio - HARVEST_TRAIL) return 'harvest';
  return null;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(track(bar.symbol), bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const orders: (SellInput | BuyInput)[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const t = track(symbol);
      const held = state.positions.get(symbol);
      if (held === undefined) {
        if (t.wasHeld) {
          t.wasHeld = false;
          t.cooldown = t.pendingCooldown;
          t.peakRatio = 0;
          t.tier1Done = false;
        }
        if (state.positions.size >= caps.max_open_positions) continue;
        if (!enters(t)) continue;
        const stake = state.cash < state.weightRoom(symbol) ? state.cash : state.weightRoom(symbol);
        if (stake < minNotional || stake === 0n) continue;
        orders.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
        t.wasHeld = true;
        t.heldBefore = true;
      } else {
        t.wasHeld = true;
        t.heldBefore = true;
        const kind = exitKind(state, symbol, t, held);
        if (kind === 'tier1') {
          const part = (held.qty * 2n) / 5n;
          if (part > 0n && state.value(symbol, part) >= minNotional) {
            orders.push({ side: 'sell', symbol, qty: part, max_slippage_bps: MAX_SLIPPAGE_BPS });
            t.tier1Done = true;
          }
        } else if (kind !== null) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          t.lastExitHarvest = kind === 'harvest';
          t.pendingCooldown = kind === 'harvest' ? COOLDOWN_HARVEST : COOLDOWN_BARS;
        }
      }
    }
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
