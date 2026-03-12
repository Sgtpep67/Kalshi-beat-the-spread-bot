// ─────────────────────────────────────────────────────────────────────────────
// bot/kalshi.js
// Kalshi REST API v2 client — RSA request signing authentication
//
// Kalshi uses asymmetric key auth, not Bearer tokens.
// Each request must be signed with your RSA private key.
//
// Required env vars:
//   KALSHI_API_KEY    — your API Key ID (short string from Kalshi dashboard)
//   KALSHI_API_SECRET — your full RSA private key (-----BEGIN RSA PRIVATE KEY-----)
//
// Kalshi API docs: https://trading-api.kalshi.com/trade-api/v2/openapi.json
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const crypto = require("crypto"); // built into Node.js — no install needed

const BASE_URL = "https://trading-api.kalshi.com/trade-api/v2";

const SPORTS_SERIES_KEYWORDS = [
  "NBA", "NFL", "MLB", "NHL", "NCAAB", "NCAAF",
  "KXNBA", "KXNFL", "KXMLB", "KXNHL",
];

// ── RSA REQUEST SIGNING ───────────────────────────────────────────────────────

function buildMessage(timestampMs, method, path) {
  return `${timestampMs}${method.toUpperCase()}${path}`;
}

function signMessage(message, privateKeyPem) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(message);
  sign.end();
  return sign.sign(privateKeyPem, "base64");
}

function buildAuthHeaders(method, path, apiKeyId, privateKey) {
  const timestampMs = Date.now().toString();
  const message     = buildMessage(timestampMs, method, path);
  const signature   = signMessage(message, privateKey);
  return {
    "KALSHI-ACCESS-KEY":       apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type":            "application/json",
    "Accept":                  "application/json",
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function parseMarket(market) {
  try {
    const { ticker, title, yes_bid, yes_ask, last_price, open_interest, close_time, status } = market;
    if (status !== "open") return null;
    if (last_price == null && yes_ask == null) return null;
    const rawPrice = (yes_bid != null && yes_ask != null) ? (yes_bid + yes_ask) / 2 : last_price;
    if (rawPrice == null || rawPrice <= 0 || rawPrice >= 100) return null;
    const kalshiProb     = rawPrice / 100;
    const hoursUntilGame = close_time ? (new Date(close_time) - Date.now()) / 3_600_000 : null;
    if (hoursUntilGame !== null && hoursUntilGame < 0) return null;
    const teams = extractTeams(title);
    return { gameId: ticker, title, homeTeam: teams.home, awayTeam: teams.away, kalshiProb, openInterest: open_interest ?? 0, hoursUntilGame: hoursUntilGame ?? 999, closeTime: close_time };
  } catch { return null; }
}

function extractTeams(title) {
  if (!title) return { home: null, away: null };
  const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-—]|$)/i);
  if (vsMatch) return { home: vsMatch[1].trim(), away: vsMatch[2].trim() };
  const atMatch = title.match(/^(.+?)\s+@\s+(.+?)(?:\s*[-—]|$)/i);
  if (atMatch) return { home: atMatch[2].trim(), away: atMatch[1].trim() };
  const willMatch = title.match(/will (?:the )?(.+?)\s+(?:win|cover|beat)/i);
  if (willMatch) return { home: willMatch[1].trim(), away: null };
  return { home: null, away: null };
}

// ── API FUNCTIONS ─────────────────────────────────────────────────────────────

async function getKalshiMarkets(apiKeyId, privateKey, opts = {}) {
  const { sports = ["nba", "nfl", "mlb", "nhl"] } = opts;
  let allMarkets = [];
  let cursor     = null;

  do {
    const params   = { status: "open", limit: 200, ...(cursor ? { cursor } : {}) };
    const qs       = new URLSearchParams(params).toString();
    const fullPath = `/trade-api/v2/markets?${qs}`;

    let response;
    try {
      response = await axios.get(`${BASE_URL}/markets`, {
        headers: buildAuthHeaders("GET", fullPath, apiKeyId, privateKey),
        params,
        timeout: 12000,
      });
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) {
        console.error("[kalshi] 401 Unauthorized — check KALSHI_API_KEY and KALSHI_API_SECRET");
        console.error("[kalshi] KALSHI_API_SECRET must be the full RSA private key including -----BEGIN/END lines");
      } else {
        console.error("[kalshi] Market fetch error:", err.message);
      }
      break;
    }

    const { markets, cursor: nextCursor } = response.data;
    allMarkets = allMarkets.concat(markets ?? []);
    cursor     = nextCursor || null;
  } while (cursor);

  const sportKeywords = sports.map(s => s.toUpperCase());
  const parsed = allMarkets
    .filter(m => {
      const title  = (m.title  || "").toUpperCase();
      const ticker = (m.ticker || "").toUpperCase();
      const series = (m.event_ticker || "").toUpperCase();
      return sportKeywords.some(kw => title.includes(kw) || ticker.includes(kw) || series.includes(kw) || SPORTS_SERIES_KEYWORDS.some(sk => ticker.startsWith(sk)));
    })
    .map(parseMarket)
    .filter(Boolean);

  console.log(`[kalshi] ${parsed.length} valid sports markets (from ${allMarkets.length} total)`);
  return parsed;
}

async function placeBet({ gameId, team, stake, apiKeyId, privateKey }) {
  const count = Math.max(1, Math.floor(stake));
  const path  = "/trade-api/v2/portfolio/orders";
  const orderPayload = {
    ticker:          gameId,
    client_order_id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type:            "market",
    action:          "buy",
    side:            "yes",
    count,
  };
  try {
    const response = await axios.post(`${BASE_URL}/portfolio/orders`, orderPayload, {
      headers: buildAuthHeaders("POST", path, apiKeyId, privateKey),
      timeout: 10000,
    });
    const order = response.data?.order;
    console.log(`[kalshi] Order placed: ${team} · ${count} contracts · id=${order?.order_id}`);
    return order;
  } catch (err) {
    console.error(`[kalshi] Order failed for ${team}:`, err.response?.data?.detail || err.message);
    throw err;
  }
}

async function getBalance(apiKeyId, privateKey) {
  const path = "/trade-api/v2/portfolio/balance";
  try {
    const response = await axios.get(`${BASE_URL}/portfolio/balance`, {
      headers: buildAuthHeaders("GET", path, apiKeyId, privateKey),
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    console.error("[kalshi] Failed to fetch balance:", err.message);
    return null;
  }
}

module.exports = { getKalshiMarkets, placeBet, getBalance };
