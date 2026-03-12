// ─────────────────────────────────────────────────────────────────────────────
// bot/kalshi.js
// Kalshi REST API v2 client
//
// Handles:
//   - Fetching open sports markets with prices and open interest
//   - Placing YES orders (market or limit)
//   - Fetching current open positions
//   - Fetching settled (resolved) contracts for P&L tracking
//
// Kalshi API docs: https://trading-api.kalshi.com/trade-api/v2/openapi.json
// Kalshi pricing: contracts trade in cents (0–100).
//   A price of 65 means the market implies a 65% probability.
//   We divide by 100 to work in 0.0–1.0 internally.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const BASE_URL = "https://trading-api.kalshi.com/trade-api/v2";

// Keywords that identify sports markets in Kalshi's event catalog
// Kalshi uses series slugs like "KXNBA", "KXNFL", etc.
const SPORTS_SERIES_KEYWORDS = [
  "NBA", "NFL", "MLB", "NHL", "NCAAB", "NCAAF",
  "KXNBA", "KXNFL", "KXMLB", "KXNHL",
];

// ── HELPERS ────────────────────────────────────────────────────────────────────

/**
 * Build axios config with Kalshi auth headers.
 */
function authHeaders(apiKey) {
  return {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
    timeout: 10000,
  };
}

/**
 * Parse a Kalshi market object into a normalized game record.
 * Returns null if the market can't be parsed into a valid game.
 *
 * Kalshi market title format examples:
 *   "Will the Celtics beat the Bucks?"
 *   "Celtics vs Bucks — Winner"
 *   "NBA: Boston Celtics moneyline"
 */
function parseMarket(market) {
  try {
    const {
      ticker,
      title,
      yes_bid,        // current best YES bid price (cents)
      yes_ask,        // current best YES ask price (cents)
      last_price,     // last traded price (cents)
      open_interest,  // total open interest in dollars
      close_time,     // ISO timestamp when market closes (game start)
      status,
    } = market;

    // Skip non-open markets
    if (status !== "open") return null;

    // Skip markets with no price data
    if (last_price == null && yes_ask == null) return null;

    // Use midpoint of bid/ask for price; fall back to last_price
    const rawPrice = (yes_bid != null && yes_ask != null)
      ? (yes_bid + yes_ask) / 2
      : last_price;

    if (rawPrice == null || rawPrice <= 0 || rawPrice >= 100) return null;

    // Convert cents → probability
    const kalshiProb = rawPrice / 100;

    // Hours until game (close_time is when market closes = tip-off)
    const hoursUntilGame = close_time
      ? (new Date(close_time) - Date.now()) / 3_600_000
      : null;

    // Skip markets that have already started
    if (hoursUntilGame !== null && hoursUntilGame < 0) return null;

    // Extract team names from title (best-effort — Kalshi titles vary)
    const teams = extractTeams(title);

    return {
      gameId:         ticker,
      title,
      homeTeam:       teams.home,
      awayTeam:       teams.away,
      kalshiProb,           // YES probability (0.0–1.0)
      openInterest:   open_interest ?? 0,
      hoursUntilGame: hoursUntilGame ?? 999,
      closeTime:      close_time,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Attempt to extract home/away team names from a Kalshi market title.
 * Returns { home, away } — both may be null if parsing fails.
 *
 * Common title formats:
 *   "Celtics vs Bucks"        → home: Celtics, away: Bucks
 *   "Chiefs @ Bills"          → home: Bills, away: Chiefs  (@ means away @ home)
 *   "Will the Lakers win?"    → home: Lakers, away: null
 */
function extractTeams(title) {
  if (!title) return { home: null, away: null };

  // Format: "Team A vs Team B"
  const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-—]|$)/i);
  if (vsMatch) {
    return { home: vsMatch[1].trim(), away: vsMatch[2].trim() };
  }

  // Format: "Team A @ Team B" (away @ home)
  const atMatch = title.match(/^(.+?)\s+@\s+(.+?)(?:\s*[-—]|$)/i);
  if (atMatch) {
    return { home: atMatch[2].trim(), away: atMatch[1].trim() };
  }

  // Format: "Will the [Team] win?" — extract single team
  const willMatch = title.match(/will (?:the )?(.+?)\s+(?:win|cover|beat)/i);
  if (willMatch) {
    return { home: willMatch[1].trim(), away: null };
  }

  return { home: null, away: null };
}

// ── API FUNCTIONS ──────────────────────────────────────────────────────────────

/**
 * Fetch all open sports markets from Kalshi.
 * Filters to sports-related markets only.
 * Returns an array of normalized game objects.
 *
 * @param {string} apiKey - Kalshi API key (from KALSHI_API_KEY env var)
 * @param {object} opts   - Options
 * @param {string[]} opts.sports - Sports to include e.g. ['nba', 'nfl']
 * @returns {Promise<Array>} Array of parsed market objects
 */
async function getKalshiMarkets(apiKey, opts = {}) {
  const { sports = ["nba", "nfl", "mlb", "nhl"] } = opts;

  let allMarkets = [];
  let cursor     = null;

  // Kalshi paginates — loop through all pages
  do {
    const params = {
      status: "open",
      limit:  200,
      ...(cursor ? { cursor } : {}),
    };

    let response;
    try {
      response = await axios.get(
        `${BASE_URL}/markets`,
        { ...authHeaders(apiKey), params }
      );
    } catch (err) {
      if (err.response?.status === 401) {
        console.error("[kalshi] Authentication failed — check KALSHI_API_KEY");
        throw err;
      }
      console.error("[kalshi] Failed to fetch markets:", err.message);
      break;
    }

    const { markets, cursor: nextCursor } = response.data;
    allMarkets = allMarkets.concat(markets ?? []);
    cursor     = nextCursor || null;

  } while (cursor);

  // Filter to sports markets and parse
  const sportKeywords = sports.map(s => s.toUpperCase());

  const parsed = allMarkets
    .filter(m => {
      const title   = (m.title || "").toUpperCase();
      const ticker  = (m.ticker || "").toUpperCase();
      const series  = (m.event_ticker || "").toUpperCase();
      return sportKeywords.some(kw =>
        title.includes(kw) || ticker.includes(kw) || series.includes(kw) ||
        SPORTS_SERIES_KEYWORDS.some(sk => ticker.startsWith(sk))
      );
    })
    .map(parseMarket)
    .filter(Boolean);  // remove nulls from failed parses

  console.log(`[kalshi] Found ${parsed.length} valid sports markets (from ${allMarkets.length} total open markets)`);
  return parsed;
}

/**
 * Place a YES order on a Kalshi market.
 * In PAPER_MODE this function is never called — index.js guards that.
 *
 * Kalshi order types:
 *   "market" — fills immediately at best available price
 *   "limit"  — fills only at your specified price or better
 *
 * We use market orders for simplicity. Limit orders are safer but may not fill.
 *
 * @param {object} params
 * @param {string} params.gameId     - Kalshi market ticker
 * @param {string} params.team       - Team name (for logging only)
 * @param {number} params.stake      - Dollar amount to bet
 * @param {string} params.apiKey     - Kalshi API key
 * @param {string} [params.apiSecret] - Kalshi API secret (required for some auth flows)
 * @returns {Promise<object>} Kalshi order response
 */
async function placeBet({ gameId, team, stake, apiKey, apiSecret }) {
  // Kalshi counts are in $0.01 increments — convert dollar stake to cents
  // Actually Kalshi "count" = number of contracts, each worth $1 at settlement
  // So $137.50 stake → 137 contracts (at ~65¢ each = ~$89 cost, wins $137 if yes)
  // For simplicity we treat count = Math.floor(stake) as dollar-equivalent contracts

  const count = Math.max(1, Math.floor(stake));

  const orderPayload = {
    ticker:      gameId,
    client_order_id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type:        "market",
    action:      "buy",
    side:        "yes",
    count,
    // For limit orders, uncomment and set price:
    // type:  "limit",
    // price: Math.round(targetPriceCents),  // e.g. 65 for 65¢
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/portfolio/orders`,
      orderPayload,
      authHeaders(apiKey)
    );

    const order = response.data?.order;
    console.log(`[kalshi] Order placed: ${team} · ${count} contracts · order_id=${order?.order_id}`);
    return order;

  } catch (err) {
    const detail = err.response?.data?.detail || err.message;
    console.error(`[kalshi] Order failed for ${team} (${gameId}):`, detail);
    throw err;
  }
}

/**
 * Fetch current open positions (bets not yet settled).
 *
 * @param {string} apiKey
 * @returns {Promise<Array>} Array of open position objects
 */
async function getOpenPositions(apiKey) {
  try {
    const response = await axios.get(
      `${BASE_URL}/portfolio/positions`,
      { ...authHeaders(apiKey), params: { limit: 100 } }
    );
    return response.data?.market_positions ?? [];
  } catch (err) {
    console.error("[kalshi] Failed to fetch positions:", err.message);
    return [];
  }
}

/**
 * Fetch recently settled (resolved) contracts.
 * Use this to automatically mark paper bets as won/lost once games end.
 *
 * @param {string} apiKey
 * @param {number} limit  - Max results to return (default 50)
 * @returns {Promise<Array>} Array of settlement objects
 */
async function getSettlements(apiKey, limit = 50) {
  try {
    const response = await axios.get(
      `${BASE_URL}/portfolio/settlements`,
      { ...authHeaders(apiKey), params: { limit } }
    );
    return response.data?.settlements ?? [];
  } catch (err) {
    console.error("[kalshi] Failed to fetch settlements:", err.message);
    return [];
  }
}

/**
 * Get account balance / portfolio summary.
 * Useful for tracking real bankroll vs the in-memory estimate.
 *
 * @param {string} apiKey
 * @returns {Promise<object|null>}
 */
async function getBalance(apiKey) {
  try {
    const response = await axios.get(
      `${BASE_URL}/portfolio/balance`,
      authHeaders(apiKey)
    );
    return response.data;
  } catch (err) {
    console.error("[kalshi] Failed to fetch balance:", err.message);
    return null;
  }
}

module.exports = {
  getKalshiMarkets,
  placeBet,
  getOpenPositions,
  getSettlements,
  getBalance,
  parseMarket,
  extractTeams,
};
