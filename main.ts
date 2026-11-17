// Patient dip-and-hold bot for the BTC 24h bars race (agent-fun/bars-replay/v1).
//
// A full-size round trip costs roughly 0.3-0.4% in fees, slippage and
// impact, and one-minute bars mostly wiggle by less than that, so a bot
// that trades every wiggle pays the pool for nothing: on the published
// dev window the churny crossover style loses heavily while simply
// holding makes money. This bot trades as rarely as it can, and it
// refuses to chase: it buys weakness, not strength.
//
//   - Entry: it watches the first close it sees as its reference and
//     buys once the close offers a 0.2% discount under it, a dip about
//     the size of the round trip's cost. If no dip has come by bar
//     240 it buys then anyway, so a window that only climbs is still
//     ridden; either way it stays out while the tape is in free fall
//     (60-bar change under -1%). One position, sized to the cash on
//     hand under the weight cap.
//   - Exit, the whole position, on either disaster signal only: the
//     position worth 6% less than its cost, or the close 3% under its
//     60-bar exponential average, a break deep enough that noise
//     cannot fake it. Anything shallower is ridden out: the position
//     is otherwise held to the end of the window and sold by the
//     replay's own close.
//   - Re-entry after an exit: only once the close is back within 0.5%
//     under the average and the 60-bar change is no longer negative,
//     and never sooner than 30 bars after the exit.
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
/** Bars to sit out after a position closes. */
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
  /** Whether the last batch held a position in this symbol. */
  wasHeld: boolean;
  /** Whether this run has ever held the symbol (first entry vs re-entry). */
  heldBefore: boolean;
}

const tracks = new Map<string, Track>();

function track(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [], seed: [], ema: null, firstClose: null, bars: 0, cooldown: 0, wasHeld: false, heldBefore: false };
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
  if (t.ema === null) return false;
  return r !== null && r >= REENTRY_ROC && close >= t.ema * (1 - REENTRY_BAND);
}

/** Whether a held position exits on this close: the hard stop, or a close deep under the trend line. */
function exits(state: BarsState, symbol: string, t: Track, held: { qty: bigint; cost: bigint }): boolean {
  const value = state.value(symbol, held.qty);
  if (value * 100n <= held.cost * 94n) return true;
  const close = state.close(symbol);
  return close !== null && t.ema !== null && Number(close) <= t.ema * (1 - BREAK_BAND);
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
          t.cooldown = COOLDOWN_BARS;
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
        if (exits(state, symbol, t, held)) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
