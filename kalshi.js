// bot/kalshi.js — Kalshi REST API v2 client
// Auth: RSA-PSS SHA256 request signing
// Signing message: timestampMs + METHOD + FULL_PATH (no query string)
// Full path means from root: /trade-api/v2/portfolio/balance

const axios  = require("axios");
const crypto = require("crypto");

const BASE_URL = "https://trading-api.kalshi.com/trade-api/v2";

const SPORTS_PREFIXES = [
  "KXNBA", "KXNFL", "KXMLB", "KXNHL", "KXNCAAB", "KXNCAAF",
  "NBA", "NFL", "MLB", "NHL",
];

// ── SIGNING ───────────────────────────────────────────────────────────────────

function makeHeaders(method, endpoint, apiKeyId, privateKey) {
  // endpoint = short path e.g. "/markets" or "/portfolio/balance"
  // fullPath = what gets signed = /trade-api/v2 + endpoint (no query string)
  const fullPath    = "/trade-api/v2" + endpoint.split("?")[0];
  const timestampMs = Date.now().toString();
  const message     = `${timestampMs}${method.toUpperCase()}${fullPath}`;
  console.log(`[kalshi] signing: method=${method} path=${fullPath} keyPresent=${!!privateKey} keyLen=${privateKey?.length}`);

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  const signature = signer.sign({
    key:        privateKey,
    padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, "base64");

  return {
    "KALSHI-ACCESS-KEY":       apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type":            "application/json",
    "Accept":                  "application/json",
  };
}

// ── MARKET PARSING ────────────────────────────────────────────────────────────

function isSportsMarket(m) {
  const ticker = (m.ticker || "").toUpperCase();
  const series = (m.event_ticker || "").toUpperCase();
  const title  = (m.title || "").toUpperCase();
  return SPORTS_PREFIXES.some(p =>
    ticker.startsWith(p) || series.startsWith(p) ||
    title.includes(" NBA ") || title.includes(" NFL ") ||
    title.includes(" MLB ") || title.includes(" NHL ")
  );
}

function parsePrice(market) {
  // March 12 2026: Kalshi removed integer cents fields, use _dollars strings
  const bid  = market.yes_bid_dollars  != null ? parseFloat(market.yes_bid_dollars)  : null;
  const ask  = market.yes_ask_dollars  != null ? parseFloat(market.yes_ask_dollars)  : null;
  const last = market.last_price_dollars != null ? parseFloat(market.last_price_dollars) : null;
  // Fallback to old cents fields just in case
  const bidC  = market.yes_bid   != null ? market.yes_bid  / 100 : null;
  const askC  = market.yes_ask   != null ? market.yes_ask  / 100 : null;
  const lastC = market.last_price != null ? market.last_price / 100 : null;

  const b = bid  ?? bidC;
  const a = ask  ?? askC;
  const l = last ?? lastC;

  if (b != null && a != null) return (b + a) / 2;
  if (l != null) return l;
  if (a != null) return a;
  return null;
}

function extractTeams(title) {
  if (!title) return { home: null, away: null };
  const vs = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-—(]|$)/i);
  if (vs) return { home: vs[1].trim(), away: vs[2].trim() };
  const at = title.match(/^(.+?)\s+@\s+(.+?)(?:\s*[-—(]|$)/i);
  if (at) return { home: at[2].trim(), away: at[1].trim() };
  return { home: title.trim(), away: null };
}

function parseMarket(m) {
  try {
    if (m.status !== "open") return null;
    const price = parsePrice(m);
    if (price == null || price <= 0 || price >= 1) return null;
    const hoursUntilGame = m.close_time
      ? (new Date(m.close_time) - Date.now()) / 3_600_000
      : 999;
    if (hoursUntilGame < 0) return null;
    const teams = extractTeams(m.title || "");
    return {
      gameId:         m.ticker,
      title:          m.title,
      homeTeam:       teams.home,
      awayTeam:       teams.away,
      kalshiProb:     price,
      openInterest:   m.open_interest ?? 0,
      hoursUntilGame,
      closeTime:      m.close_time,
    };
  } catch { return null; }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

async function getKalshiMarkets(apiKeyId, privateKey) {
  if (!apiKeyId || !privateKey) {
    console.error("[kalshi] Missing API key or private key");
    return [];
  }

  let allMarkets = [];
  let cursor     = null;
  let page       = 0;

  do {
    const endpoint = "/markets";
    const params   = { status: "open", limit: 200, ...(cursor ? { cursor } : {}) };
    try {
      const resp = await axios.get(`${BASE_URL}${endpoint}`, {
        headers: makeHeaders("GET", endpoint, apiKeyId, privateKey),
        params,
        timeout: 15000,
      });
      const data = resp.data;
      allMarkets = allMarkets.concat(data.markets ?? []);
      cursor     = data.cursor || null;
      page++;
      console.log(`[kalshi] page ${page}: ${data.markets?.length ?? 0} markets, cursor=${!!cursor}`);
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) {
        console.error("[kalshi] 401 — API key or signature wrong. Check KALSHI_API_KEY and KALSHI_API_SECRET in Render env vars.");
      } else {
        console.error("[kalshi] fetch error:", err.message);
      }
      break;
    }
  } while (cursor && page < 10);

  console.log(`[kalshi] total raw markets fetched: ${allMarkets.length}`);

  const sports  = allMarkets.filter(isSportsMarket);
  console.log(`[kalshi] sports markets after filter: ${sports.length}`);

  // Log first 5 tickers to help diagnose filter misses
  if (allMarkets.length > 0 && sports.length === 0) {
    console.log("[kalshi] sample tickers:", allMarkets.slice(0, 5).map(m => m.ticker).join(", "));
  }

  return sports.map(parseMarket).filter(Boolean);
}

async function placeBet({ gameId, team, stake, marketProb, apiKeyId, privateKey }) {
  const count      = Math.max(1, Math.floor(stake));
  const limitCents = Math.min(99, Math.round((marketProb + 0.02) * 100));
  const endpoint   = "/portfolio/orders";
  const payload    = {
    ticker:          gameId,
    client_order_id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    action:          "buy",
    side:            "yes",
    count,
    yes_price:       limitCents,
  };
  try {
    const resp = await axios.post(`${BASE_URL}${endpoint}`, payload, {
      headers: makeHeaders("POST", endpoint, apiKeyId, privateKey),
      timeout: 10000,
    });
    const order = resp.data?.order;
    console.log(`[kalshi] order placed: ${team} · ${count} contracts · id=${order?.order_id}`);
    return order;
  } catch (err) {
    console.error(`[kalshi] order failed for ${team}:`, err.response?.data?.detail || err.message);
    throw err;
  }
}

async function getBalance(apiKeyId, privateKey) {
  if (!apiKeyId || !privateKey) return null;
  const endpoint = "/portfolio/balance";
  try {
    const resp = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: makeHeaders("GET", endpoint, apiKeyId, privateKey),
      timeout: 10000,
    });
    const d = resp.data;
    console.log("[kalshi] raw balance response:", JSON.stringify(d));
    // Try _dollars fields first (new format), fall back to cents
    const bal  = d.balance_dollars  != null ? parseFloat(d.balance_dollars)
               : d.balance          != null ? d.balance / 100
               : 0;
    const port = d.portfolio_value_dollars != null ? parseFloat(d.portfolio_value_dollars)
               : d.portfolio_value         != null ? d.portfolio_value / 100
               : 0;
    return { balance: bal, portfolio_value: port };
  } catch (err) {
    console.error("[kalshi] balance error:", err.response?.status, err.message);
    return null;
  }
}

module.exports = { getKalshiMarkets, placeBet, getBalance };
