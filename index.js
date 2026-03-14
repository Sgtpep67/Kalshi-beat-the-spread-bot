require("dotenv").config();
const express = require("express");
const path    = require("path");
const { getKalshiMarkets, placeBet, getBalance } = require("./kalshi");
const { getSharpOdds } = require("./odds");
const { eloToWinProb, getElo } = require("./elo");

const app = express();
app.use(express.json());

app.get("/",           (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/api/health", (req, res) => res.json({ ok: true }));

//  CONFIG 
const CONFIG = {
  PAPER_MODE:        process.env.PAPER_MODE !== "false",
  MIN_EDGE_PCT:      parseFloat(process.env.MIN_EDGE_PCT      || "5"),
  MAX_BET_USD:       parseFloat(process.env.MAX_BET_USD       || "5"),
  DAILY_LOSS_LIMIT:  parseFloat(process.env.DAILY_LOSS_LIMIT  || "50"),
  MAX_CONSEC_LOSSES: parseInt(  process.env.MAX_CONSEC_LOSSES || "4"),
  MAX_CONCURRENT:    parseInt(  process.env.MAX_CONCURRENT    || "3"),
  MIN_LIQUIDITY:     parseFloat(process.env.MIN_LIQUIDITY     || "500"),
  MAX_HOURS_TO_GAME: parseFloat(process.env.MAX_HOURS_TO_GAME || "4"),
  KELLY_FRACTION:    parseFloat(process.env.KELLY_FRACTION    || "0.25"),
  ELO_WEIGHT:        parseFloat(process.env.ELO_WEIGHT        || "0.40"),
  KALSHI_API_KEY:    process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY:(process.env.KALSHI_API_SECRET || "").replace(/\\n/g, "\n"),
  ODDS_API_KEY:      process.env.ODDS_API_KEY,
};

//  STATE 
let state = {
  running:           false,
  inCooldown:        false,
  cooldownAt:        null,
  consecutiveLosses: 0,
  todayLoss:         0,
  openBets:          [],
  settledBets:       [],
  betLockSet:        new Set(),
  log:               [],
  kalshiBalance:     null,
  portfolioValue:    null,
  balanceUpdatedAt:  null,
};

//  HELPERS 
function pushLog(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  state.log.push({ t, msg });
  if (state.log.length > 200) state.log.shift();
  console.log("[" + t + "] " + msg);
}

function isGameLocked(gameId) {
  const today = new Date().toISOString().slice(0, 10);
  return state.betLockSet.has(gameId + "-" + today);
}

function lockGame(gameId) {
  const today = new Date().toISOString().slice(0, 10);
  state.betLockSet.add(gameId + "-" + today);
}

async function refreshBalance() {
  if (!CONFIG.KALSHI_API_KEY || !CONFIG.KALSHI_PRIVATE_KEY) return;
  try {
    const bal = await getBalance(CONFIG.KALSHI_API_KEY, CONFIG.KALSHI_PRIVATE_KEY);
    if (bal) {
      state.kalshiBalance   = bal.balance;
      state.portfolioValue  = bal.portfolio_value;
      state.balanceUpdatedAt = new Date().toISOString();
      pushLog("[balance] $" + bal.balance.toFixed(2) + " available");
    }
  } catch (err) {
    pushLog("[balance] fetch failed: " + err.message);
  }
}

//  FAIR VALUE ENGINE 
function computeFairValue(homeTeam, awayTeam, sharpHomeProb, hoursUntilGame) {
  const homeElo    = getElo(homeTeam);
  const awayElo    = getElo(awayTeam);
  const eloProb    = eloToWinProb(homeElo, awayElo, 65);
  const sharpWeight = Math.min(0.85, 0.40 + 0.45 * Math.max(0, 1 - hoursUntilGame / 72));
  return eloProb * (1 - sharpWeight) + sharpHomeProb * sharpWeight;
}

function kellySize(fairProb, marketProb) {
  const b     = (1 / marketProb) - 1;
  const q     = 1 - fairProb;
  const kelly = (fairProb * b - q) / b;
  const frac  = Math.max(0, kelly * CONFIG.KELLY_FRACTION);
  return Math.min(CONFIG.MAX_BET_USD, frac * 2500);
}

//  SCAN 
async function scan() {
  if (!state.running || state.inCooldown) return;
  await refreshBalance();

  if (state.todayLoss >= CONFIG.DAILY_LOSS_LIMIT) {
    state.running = false;
    pushLog("Daily loss limit reached - bot halted");
    return;
  }
  if (state.openBets.length >= CONFIG.MAX_CONCURRENT) {
    pushLog("Max concurrent bets reached - skipping scan");
    return;
  }

  try {
    const markets = await getKalshiMarkets(CONFIG.KALSHI_API_KEY, CONFIG.KALSHI_PRIVATE_KEY);
    pushLog("[kalshi] " + markets.length + " sports markets fetched");

    const odds      = await getSharpOdds(CONFIG.ODDS_API_KEY);
    const oddsCount = Object.keys(odds).length;
    pushLog("[odds] " + oddsCount + " games with sharp lines fetched");

    if (markets.length === 0) {
      pushLog("[scan] No Kalshi sports markets found");
      return;
    }

    for (const market of markets) {
      const { gameId, homeTeam, awayTeam, kalshiProb: kalshiHomeProb, openInterest, hoursUntilGame } = market;

      if (openInterest < CONFIG.MIN_LIQUIDITY) continue;
      if (hoursUntilGame > CONFIG.MAX_HOURS_TO_GAME) continue;
      if (isGameLocked(gameId)) continue;
      if (state.openBets.length >= CONFIG.MAX_CONCURRENT) break;

      const sharpHome = odds[gameId] ? odds[gameId].homeProb : kalshiHomeProb;
      const fairHome  = computeFairValue(homeTeam, awayTeam, sharpHome, hoursUntilGame);
      const edge      = fairHome - kalshiHomeProb;

      if (edge * 100 < CONFIG.MIN_EDGE_PCT) continue;

      const stake = kellySize(fairHome, kalshiHomeProb);
      pushLog("SIGNAL " + homeTeam + " +" + (edge * 100).toFixed(1) + "% edge");

      if (!CONFIG.PAPER_MODE) {
        await placeBet({ gameId, team: homeTeam, stake, marketProb: kalshiHomeProb, apiKeyId: CONFIG.KALSHI_API_KEY, privateKey: CONFIG.KALSHI_PRIVATE_KEY });
        pushLog("LIVE BET $" + stake.toFixed(2) + " on " + homeTeam);
      } else {
        pushLog("PAPER BET $" + stake.toFixed(2) + " on " + homeTeam);
      }

      lockGame(gameId);
      await refreshBalance();
      state.openBets.push({ gameId, team: homeTeam, awayTeam, sport: market.sport || "unknown", stake, edge, fairProb: fairHome, marketProb: kalshiHomeProb });
    }
  } catch (err) {
    pushLog("ERROR in scan: " + err.message);
  }
}

//  RESULT HANDLER 
function handleResult(gameId, won) {
  const bet = state.openBets.find(function(b) { return b.gameId === gameId; });
  if (!bet) return;
  state.openBets = state.openBets.filter(function(b) { return b.gameId !== gameId; });

  const pnl = won ? parseFloat((bet.stake * (1 / bet.marketProb - 1)).toFixed(2)) : -bet.stake;

  refreshBalance().catch(function() {});

  state.settledBets.push({
    id:        state.settledBets.length + 1,
    gameId:    gameId,
    team:      bet.team,
    opp:       bet.awayTeam || "",
    sport:     bet.sport || "unknown",
    stake:     bet.stake,
    edge:      bet.edge || 0,
    status:    won ? "WON" : "LOST",
    pnl:       pnl,
    settledAt: new Date().toISOString(),
  });

  if (won) {
    state.consecutiveLosses = 0;
    pushLog("WIN " + bet.team + " +$" + pnl.toFixed(2));
  } else {
    state.todayLoss += bet.stake;
    state.consecutiveLosses++;
    pushLog("LOSS " + bet.team + " -$" + bet.stake.toFixed(2) + " consec:" + state.consecutiveLosses);
    if (state.consecutiveLosses >= CONFIG.MAX_CONSEC_LOSSES) {
      state.running    = false;
      state.inCooldown = true;
      state.cooldownAt = new Date();
      pushLog("COOLDOWN - " + CONFIG.MAX_CONSEC_LOSSES + " consecutive losses. Manual restart required.");
    }
  }
}

//  API ENDPOINTS 
app.post("/api/scan", async function(req, res) {
  pushLog("Manual scan triggered");
  const wasStopped = !state.running;
  if (wasStopped) state.running = true;
  try {
    await scan();
    if (wasStopped) state.running = false;
    res.json({ ok: true });
  } catch (err) {
    if (wasStopped) state.running = false;
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/state", function(req, res) {
  const out = Object.assign({}, state);
  delete out.betLockSet;
  res.json(out);
});

app.get("/api/config", function(req, res) {
  res.json(CONFIG);
});

app.post("/api/start", async function(req, res) {
  if (state.inCooldown) return res.status(400).json({ error: "In cooldown - clear first" });
  state.running = true;
  pushLog("Bot STARTED - " + (CONFIG.PAPER_MODE ? "PAPER" : "LIVE"));
  await refreshBalance();
  res.json({ ok: true });
});

app.post("/api/stop", function(req, res) {
  state.running = false;
  pushLog("Bot STOPPED");
  res.json({ ok: true });
});

app.post("/api/cooldown/clear", function(req, res) {
  state.inCooldown        = false;
  state.cooldownAt        = null;
  state.consecutiveLosses = 0;
  state.running           = true;
  pushLog("COOLDOWN CLEARED - restarted");
  res.json({ ok: true });
});

app.post("/api/result", function(req, res) {
  handleResult(req.body.gameId, req.body.won);
  res.json({ ok: true });
});

app.get("/api/balance", async function(req, res) {
  try {
    const balance = await getBalance(CONFIG.KALSHI_API_KEY, CONFIG.KALSHI_PRIVATE_KEY);
    res.json({ ok: true, balance: balance });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/signtest", async function(req, res) {
  var crypto = require("crypto");
  var key    = CONFIG.KALSHI_PRIVATE_KEY || "";
  var lines  = key.split("\n");
  var ts     = Date.now().toString();
  var msg    = ts + "GET" + "/trade-api/v2/portfolio/balance";

  // Report key structure
  var report = {
    keyLength:    key.length,
    lineCount:    lines.length,
    firstLine:    lines[0],
    lastLine:     lines[lines.length - 1],
    hasBegin:     key.indexOf("BEGIN RSA PRIVATE KEY") > -1,
    hasEnd:       key.indexOf("END RSA PRIVATE KEY") > -1,
    hasNewlines:  key.indexOf("\n") > -1,
    signResult:   null,
    signError:    null,
  };

  // Try to sign
  try {
    var signer = crypto.createSign("SHA256");
    signer.update(msg);
    signer.end();
    var sig = signer.sign({
      key:        key,
      padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, "base64");
    report.signResult = "SUCCESS - sig length: " + sig.length;
  } catch(err) {
    report.signError = err.message;
  }

  // Now try actual Kalshi API call
  try {
    var axios = require("axios");
    var signer2 = crypto.createSign("SHA256");
    signer2.update(msg);
    signer2.end();
    var sig2 = signer2.sign({
      key:        key,
      padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, "base64");
    var resp = await axios.get("https://api.elections.kalshi.com/trade-api/v2/portfolio/balance", {
      headers: {
        "KALSHI-ACCESS-KEY":       CONFIG.KALSHI_API_KEY,
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "KALSHI-ACCESS-SIGNATURE": sig2,
        "Accept":                  "application/json",
      },
      timeout: 8000,
    });
    report.kalshiResult = resp.data;
  } catch(err) {
    report.kalshiError  = err.message;
    report.kalshiStatus = err.response ? err.response.status : null;
    report.kalshiBody   = err.response ? err.response.data   : null;
  }

  res.json(report);
});

app.get("/api/keycheck", function(req, res) {
  const key   = CONFIG.KALSHI_PRIVATE_KEY || "";
  const lines = key.split("\n");
  res.json({
    keyId:           CONFIG.KALSHI_API_KEY,
    keyIdLength:     (CONFIG.KALSHI_API_KEY || "").length,
    keyLength:       key.length,
    hasBegin:        key.indexOf("BEGIN RSA PRIVATE KEY") > -1,
    hasEnd:          key.indexOf("END RSA PRIVATE KEY") > -1,
    hasRealNewlines: key.indexOf("\n") > -1,
    lineCount:       lines.length,
    firstLine:       lines[0] || "",
    lastLine:        lines[lines.length - 1] || "",
  });
});

app.get("/api/debug/markets", async function(req, res) {
  try {
    const axios  = require("axios");
    const crypto = require("crypto");
    const BASE   = "https://api.elections.kalshi.com/trade-api/v2";
    const ts     = Date.now().toString();
    const sigPath = "/trade-api/v2/markets";
    const msg    = ts + "GET" + sigPath;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(msg);
    signer.end();
    const sig = signer.sign({
      key:        CONFIG.KALSHI_PRIVATE_KEY,
      padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, "base64");
    const resp = await axios.get(BASE + "/markets", {
      headers: {
        "KALSHI-ACCESS-KEY":       CONFIG.KALSHI_API_KEY,
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "KALSHI-ACCESS-SIGNATURE": sig,
        "Accept": "application/json",
      },
      params: { status: "open", limit: 20 },
      timeout: 10000,
    });
    const all = resp.data.markets || [];
    res.json({
      total: all.length,
      sample: all.slice(0, 20).map(function(m) {
        return { ticker: m.ticker, title: m.title, event_ticker: m.event_ticker, status: m.status };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response ? err.response.status : null });
  }
});

//  START 
setInterval(scan, 60000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("KalshiBot running on port " + PORT);
  refreshBalance().catch(function() {});
});
