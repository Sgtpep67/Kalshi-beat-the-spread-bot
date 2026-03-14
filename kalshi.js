const axios  = require("axios");
const crypto = require("crypto");

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

const SPORTS_PREFIXES = [
  "KXNBA", "KXNFL", "KXMLB", "KXNHL", "KXNCAAB", "KXNCAAF",
  "NBA", "NFL", "MLB", "NHL",
];

function makeHeaders(method, endpoint, apiKeyId, privateKey) {
  var fullPath    = "/trade-api/v2" + endpoint.split("?")[0];
  var timestampMs = Date.now().toString();
  var message     = timestampMs + method.toUpperCase() + fullPath;

  // Kalshi uses RSA-PSS with SHA256
  // Handle both PKCS#1 (-----BEGIN RSA PRIVATE KEY-----) 
  // and PKCS#8 (-----BEGIN PRIVATE KEY-----) formats
  var signer = crypto.createSign("SHA256");
  signer.update(message);
  signer.end();
  var signature = signer.sign({
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

function isSportsMarket(m) {
  var ticker = (m.ticker || "").toUpperCase();
  var series = (m.event_ticker || "").toUpperCase();
  var title  = (m.title || "").toUpperCase();
  return SPORTS_PREFIXES.some(function(p) {
    return ticker.startsWith(p) || series.startsWith(p) ||
      title.indexOf(" NBA ") > -1 || title.indexOf(" NFL ") > -1 ||
      title.indexOf(" MLB ") > -1 || title.indexOf(" NHL ") > -1;
  });
}

function parsePrice(market) {
  var bid  = market.yes_bid_dollars  != null ? parseFloat(market.yes_bid_dollars)  : null;
  var ask  = market.yes_ask_dollars  != null ? parseFloat(market.yes_ask_dollars)  : null;
  var last = market.last_price_dollars != null ? parseFloat(market.last_price_dollars) : null;
  var bidC  = market.yes_bid    != null ? market.yes_bid    / 100 : null;
  var askC  = market.yes_ask    != null ? market.yes_ask    / 100 : null;
  var lastC = market.last_price != null ? market.last_price / 100 : null;
  var b = bid  != null ? bid  : bidC;
  var a = ask  != null ? ask  : askC;
  var l = last != null ? last : lastC;
  if (b != null && a != null) return (b + a) / 2;
  if (l != null) return l;
  if (a != null) return a;
  return null;
}

function extractTeams(title) {
  if (!title) return { home: null, away: null };
  var vs = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-\u2014(]|$)/i);
  if (vs) return { home: vs[1].trim(), away: vs[2].trim() };
  var at = title.match(/^(.+?)\s+@\s+(.+?)(?:\s*[-\u2014(]|$)/i);
  if (at) return { home: at[2].trim(), away: at[1].trim() };
  return { home: title.trim(), away: null };
}

function parseMarket(m) {
  try {
    if (m.status !== "open") return null;
    var price = parsePrice(m);
    if (price == null || price <= 0 || price >= 1) return null;
    var hoursUntilGame = m.close_time
      ? (new Date(m.close_time) - Date.now()) / 3600000
      : 999;
    if (hoursUntilGame < 0) return null;
    var teams = extractTeams(m.title || "");
    return {
      gameId:         m.ticker,
      title:          m.title,
      homeTeam:       teams.home,
      awayTeam:       teams.away,
      kalshiProb:     price,
      openInterest:   m.open_interest != null ? m.open_interest : 0,
      hoursUntilGame: hoursUntilGame,
      closeTime:      m.close_time,
    };
  } catch(e) { return null; }
}

async function getKalshiMarkets(apiKeyId, privateKey) {
  if (!apiKeyId || !privateKey) {
    console.log("[kalshi] Missing API key or private key");
    return [];
  }

  var allMarkets = [];
  var cursor     = null;
  var page       = 0;

  do {
    var endpoint = "/markets";
    var params   = { status: "open", limit: 200 };
    if (cursor) params.cursor = cursor;
    try {
      var resp = await axios.get(BASE_URL + endpoint, {
        headers: makeHeaders("GET", endpoint, apiKeyId, privateKey),
        params:  params,
        timeout: 15000,
      });
      var data = resp.data;
      var batch = data.markets || [];
      allMarkets = allMarkets.concat(batch);
      cursor = data.cursor || null;
      page++;
      console.log("[kalshi] page " + page + ": " + batch.length + " markets fetched");
    } catch(err) {
      var status = err.response ? err.response.status : null;
      if (status === 401) {
        console.log("[kalshi] 401 Unauthorized - check API key and private key in Render env vars");
      } else {
        console.log("[kalshi] fetch error: " + err.message);
      }
      break;
    }
  } while (cursor && page < 10);

  console.log("[kalshi] total raw markets: " + allMarkets.length);

  var sports = allMarkets.filter(isSportsMarket);
  console.log("[kalshi] sports markets after filter: " + sports.length);

  if (allMarkets.length > 0 && sports.length === 0) {
    var sample = allMarkets.slice(0, 5).map(function(m) { return m.ticker; }).join(", ");
    console.log("[kalshi] sample tickers (no sports found): " + sample);
  }

  return sports.map(parseMarket).filter(Boolean);
}

async function placeBet(opts) {
  var gameId     = opts.gameId;
  var team       = opts.team;
  var stake      = opts.stake;
  var marketProb = opts.marketProb;
  var apiKeyId   = opts.apiKeyId;
  var privateKey = opts.privateKey;

  var count      = Math.max(1, Math.floor(stake));
  var limitCents = Math.min(99, Math.round((marketProb + 0.02) * 100));
  var endpoint   = "/portfolio/orders";
  var payload    = {
    ticker:          gameId,
    client_order_id: "kb_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    action:          "buy",
    side:            "yes",
    count:           count,
    yes_price:       limitCents,
  };
  try {
    var resp = await axios.post(BASE_URL + endpoint, payload, {
      headers: makeHeaders("POST", endpoint, apiKeyId, privateKey),
      timeout: 10000,
    });
    var order = resp.data ? resp.data.order : null;
    console.log("[kalshi] order placed: " + team + " " + count + " contracts");
    return order;
  } catch(err) {
    var detail = err.response && err.response.data ? err.response.data.detail : err.message;
    console.log("[kalshi] order failed for " + team + ": " + detail);
    throw err;
  }
}

async function getBalance(apiKeyId, privateKey) {
  if (!apiKeyId || !privateKey) return null;
  var endpoint = "/portfolio/balance";
  try {
    var resp = await axios.get(BASE_URL + endpoint, {
      headers: makeHeaders("GET", endpoint, apiKeyId, privateKey),
      timeout: 10000,
    });
    var d = resp.data;
    console.log("[kalshi] balance response: " + JSON.stringify(d));
    var bal  = d.balance_dollars  != null ? parseFloat(d.balance_dollars)
             : d.balance          != null ? d.balance / 100
             : 0;
    var port = d.portfolio_value_dollars != null ? parseFloat(d.portfolio_value_dollars)
             : d.portfolio_value         != null ? d.portfolio_value / 100
             : 0;
    return { balance: bal, portfolio_value: port };
  } catch(err) {
    console.log("[kalshi] balance error: " + (err.response ? err.response.status : "") + " " + err.message);
    return null;
  }
}

module.exports = { getKalshiMarkets, placeBet, getBalance };
