var axios  = require("axios");
var crypto = require("crypto");

var BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

// Individual game series tickers on Kalshi
// These are the series that have actual game-by-game markets
var GAME_SERIES = [
  "KXNBAGAME",        // NBA game winner
  "KXNFLGAME",        // NFL game winner
  "KXMLBGAME",        // MLB game winner
  "KXNHLGAME",        // NHL game winner
  "KXNCAAMBGAME",     // Men's college basketball game
  "KXNCAABGAME",      // College basketball game
  "KXNCAAMB1HWINNER", // College basketball 1H winner
  "KXNCAAFGAME",      // College football game
  "KXNCAAFD3GAME",    // College football FCS/D3 game
  "KXNCAAFCSGAME",    // College football FCS game
  "KXNCAABBGAME",     // College baseball game
  "KXNCAAHOCKEYGAME", // College hockey game
  "KXNCAALAXGAME",    // College lacrosse game
  "KXNCAAMLAXGAME",   // Men's college lacrosse game
  "KXNCAAWBGAME",     // Women's college basketball game
  "KXWNBAGAME",       // WNBA game winner
  "KXNBASERIES",      // NBA series winner
  "KXNHLSERIES",      // NHL series winner
  "KXMLBSERIES",      // MLB series winner
  "KXWNBASERIES",     // WNBA series winner
];

function makeHeaders(method, endpoint, apiKeyId, privateKey) {
  var fullPath    = "/trade-api/v2" + endpoint.split("?")[0];
  var timestampMs = Date.now().toString();
  var message     = timestampMs + method.toUpperCase() + fullPath;
  var signer      = crypto.createSign("SHA256");
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

function parsePrice(market) {
  var bid  = market.yes_bid_dollars   != null ? parseFloat(market.yes_bid_dollars)   : null;
  var ask  = market.yes_ask_dollars   != null ? parseFloat(market.yes_ask_dollars)   : null;
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

var MONTH_MAP = {
  JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5,
  JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11
};

function parseGameDateFromTicker(ticker) {
  // e.g. KXNBAGAME-26MAR16LALHOU-LAL -> extract 26MAR16
  var m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  var year  = 2000 + parseInt(m[1]);
  var month = MONTH_MAP[m[2]];
  var day   = parseInt(m[3]);
  if (month == null || isNaN(day)) return null;
  // Game time unknown from ticker - assume noon UTC as conservative estimate
  var d = new Date(Date.UTC(year, month, day, 18, 0, 0)); // 18:00 UTC = ~noon MST
  return d;
}

function extractTeams(title) {
  if (!title) return { home: null, away: null };
  var vs = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-\-(]|$)/i);
  if (vs) return { home: vs[1].trim(), away: vs[2].trim() };
  var at = title.match(/^(.+?)\s+@\s+(.+?)(?:\s*[-\-(]|$)/i);
  if (at) return { home: at[2].trim(), away: at[1].trim() };
  return { home: title.trim(), away: null };
}

function getSportFromSeries(seriesTicker) {
  if (!seriesTicker) return "unknown";
  var t = seriesTicker.toUpperCase();
  if (t.indexOf("WNBA") > -1) return "wnba";
  if (t.indexOf("NBA") > -1) return "nba";
  if (t.indexOf("NFL") > -1) return "nfl";
  if (t.indexOf("NCAABB") > -1) return "ncaabb";
  if (t.indexOf("NCAAF") > -1) return "ncaaf";
  if (t.indexOf("NCAAH") > -1 || t.indexOf("HOCKEY") > -1) return "ncaah";
  if (t.indexOf("NCAAB") > -1 || t.indexOf("NCAAMB") > -1 || t.indexOf("NCAAWB") > -1) return "ncaab";
  if (t.indexOf("MLB") > -1) return "mlb";
  if (t.indexOf("NHL") > -1) return "nhl";
  return "sports";
}

function parseMarket(m, seriesTicker) {
  try {
    // accept open, active, or any tradeable status
    var price = parsePrice(m);
    if (price == null || price <= 0 || price >= 1) return null;
    // Parse game date from ticker (more accurate than close_time which Kalshi sets to month-end)
    var tickerDate = parseGameDateFromTicker(m.ticker || "");
    var gameTime   = tickerDate ? tickerDate : (m.close_time ? new Date(m.close_time) : null);
    var hoursUntilGame = gameTime ? (gameTime - Date.now()) / 3600000 : 999;
    // Allow games from up to 4 hours ago (catches in-progress games) to 999 hours future
    if (hoursUntilGame < -4) return null;
    var teams = extractTeams(m.title || "");
    // volume_24h_fp = 24h dollar volume (best liquidity gauge  matches Kalshi UI)
    // open_interest_fp = contracts outstanding (not dollars)
    // notional_value_dollars = dollar value of open interest
    var vol24h    = m.volume_24h_fp      != null ? parseFloat(m.volume_24h_fp)      : 0;
    var volTotal  = m.volume_fp          != null ? parseFloat(m.volume_fp)           : 0;
    var notional  = m.notional_value_dollars != null ? parseFloat(m.notional_value_dollars) : 0;
    var openInt   = m.open_interest_fp   != null ? parseFloat(m.open_interest_fp)
                  : m.open_interest      != null ? m.open_interest : 0;

    return {
      gameId:          m.ticker,
      title:           m.title,
      homeTeam:        teams.home,
      awayTeam:        teams.away,
      kalshiProb:      price,
      volume24h:       vol24h,     // 24h dollar volume  PRIMARY liquidity filter
      volumeTotal:     volTotal,   // lifetime dollar volume
      notionalValue:   notional,   // dollar value of open contracts
      openInterest:    openInt,    // contracts outstanding (legacy)
      hoursUntilGame:  hoursUntilGame,
      closeTime:       m.close_time,
      sport:           getSportFromSeries(seriesTicker || m.event_ticker),
    };
  } catch(e) { return null; }
}

async function fetchMarketsBySeries(seriesTicker, apiKeyId, privateKey) {
  var allMarkets = [];
  var cursor     = null;
  var page       = 0;

  do {
    var endpoint = "/markets";
    var params = { limit: 100, series_ticker: seriesTicker };
    if (cursor) params.cursor = cursor;

    try {
      var resp = await axios.get(BASE_URL + endpoint, {
        headers: makeHeaders("GET", endpoint, apiKeyId, privateKey),
        params:  params,
        timeout: 12000,
      });
      var data  = resp.data;
      var batch = data.markets || [];
      allMarkets = allMarkets.concat(batch);
      cursor = data.cursor || null;
      page++;
    } catch(err) {
      var status = err.response ? err.response.status : null;
      if (status !== 404) {
        console.log("[kalshi] series " + seriesTicker + " error: " + err.message);
      }
      break;
    }
  } while (cursor && page < 5);

  return allMarkets;
}

async function getKalshiMarkets(apiKeyId, privateKey) {
  if (!apiKeyId || !privateKey) {
    console.log("[kalshi] Missing API key or private key");
    return [];
  }

  var allMarkets = [];

  // Fetch markets from each game series in parallel
  var fetches = GAME_SERIES.map(function(series) {
    return fetchMarketsBySeries(series, apiKeyId, privateKey).then(function(markets) {
      return { series: series, markets: markets };
    }).catch(function() {
      return { series: series, markets: [] };
    });
  });

  var results = await Promise.all(fetches);

  results.forEach(function(result) {
    if (result.markets.length > 0) {
      console.log("[kalshi] " + result.series + ": " + result.markets.length + " markets");
      result.markets.forEach(function(m) {
        m._series = result.series;
      });
      allMarkets = allMarkets.concat(result.markets);
    }
  });

  console.log("[kalshi] total game markets fetched: " + allMarkets.length);

  var parsed = allMarkets.map(function(m) {
    return parseMarket(m, m._series);
  }).filter(Boolean);

  console.log("[kalshi] valid parsed markets: " + parsed.length);
  return parsed;
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
    var d    = resp.data;
    var bal  = d.balance          != null ? d.balance          / 100 : 0;
    var port = d.portfolio_value  != null ? d.portfolio_value  / 100 : 0;
    return { balance: bal, portfolio_value: port };
  } catch(err) {
    console.log("[kalshi] balance error: " + err.message);
    return null;
  }
}

async function getSettlements(apiKeyId, privateKey, limit) {
  var endpoint = "/portfolio/settlements";
  try {
    var resp = await axios.get(BASE_URL + endpoint, {
      headers: makeHeaders("GET", endpoint, apiKeyId, privateKey),
      params:  { limit: limit || 50 },
      timeout: 10000,
    });
    return resp.data.settlements || [];
  } catch(err) {
    console.log("[kalshi] getSettlements error: " + err.message);
    return [];
  }
}

async function getPositions(apiKeyId, privateKey) {
  var endpoint = "/portfolio/positions";
  try {
    var resp = await axios.get(BASE_URL + endpoint, {
      headers: makeHeaders("GET", endpoint, apiKeyId, privateKey),
      params:  { limit: 100 },
      timeout: 10000,
    });
    return resp.data.market_positions || [];
  } catch(err) {
    console.log("[kalshi] getPositions error: " + err.message);
    return [];
  }
}

module.exports = { getKalshiMarkets, placeBet, getBalance, getSettlements, getPositions };
