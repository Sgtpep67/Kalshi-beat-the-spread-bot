require("dotenv").config();
const express = require("express");
const path    = require("path");
const { getKalshiMarkets, placeBet } = require("./kalshi");
const { getSharpOdds } = require("./odds");
const { eloToWinProb, getElo } = require("./elo");

const app = express();
app.use(express.json());

// ── SERVE DASHBOARD ───────────────────────────────────────────────────────────
app.get("/",          (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/api/health",(req, res) => res.json({ ok: true }));

// ── CONFIG FROM ENV VARS ──────────────────────────────────────────────────────
const CONFIG = {
  PAPER_MODE:         process.env.PAPER_MODE !== "false",       // default: paper
  MIN_EDGE_PCT:       parseFloat(process.env.MIN_EDGE_PCT || "5"),
  MAX_BET_USD:        parseFloat(process.env.MAX_BET_USD || "5"),
  DAILY_LOSS_LIMIT:   parseFloat(process.env.DAILY_LOSS_LIMIT || "50"),
  MAX_CONSEC_LOSSES:  parseInt(process.env.MAX_CONSEC_LOSSES || "4"),
  MAX_CONCURRENT:     parseInt(process.env.MAX_CONCURRENT || "3"),
  MIN_LIQUIDITY:      parseFloat(process.env.MIN_LIQUIDITY || "500"),
  MAX_HOURS_TO_GAME:  parseFloat(process.env.MAX_HOURS_TO_GAME || "4"),
  KELLY_FRACTION:     parseFloat(process.env.KELLY_FRACTION || "0.25"),
  ELO_WEIGHT:         parseFloat(process.env.ELO_WEIGHT || "0.40"),
  KALSHI_API_KEY:     process.env.KALSHI_API_KEY,      // short Key ID string
  KALSHI_PRIVATE_KEY: (process.env.KALSHI_API_SECRET || "").replace(/\\n/g, "\n"), // full RSA PEM
  ODDS_API_KEY:       process.env.ODDS_API_KEY,
};

// ── BOT STATE ─────────────────────────────────────────────────────────────────
let state = {
  running:            false,
  inCooldown:         false,
  cooldownAt:         null,
  consecutiveLosses:  0,
  todayLoss:          0,
  openBets:           [],
  settledBets:        [],
  betLockSet:         new Set(),
  log:                [],
  kalshiBalance:      null,   // live account balance in dollars
  portfolioValue:     null,   // balance + open position value
  balanceUpdatedAt:   null,
};

// ── DUPLICATE BET GUARD ───────────────────────────────────────────────────────
function isGameLocked(gameId) {
  const today = new Date().toISOString().slice(0, 10);
  return state.betLockSet.has(`${gameId}-${today}`);
}
function lockGame(gameId) {
  const today = new Date().toISOString().slice(0, 10);
  state.betLockSet.add(`${gameId}-${today}`);
}

// ── FAIR VALUE ENGINE ─────────────────────────────────────────────────────────
function computeFairValue(homeTeam, awayTeam, sharpHomeProb, hoursUntilGame) {
  const homeElo    = getElo(homeTeam);
  const awayElo    = getElo(awayTeam);
  const eloProb    = eloToWinProb(homeElo, awayElo, 65); // +65 home field

  // Alpha blend: weight shifts from ELO-heavy → Sharp-heavy as game approaches
  const sharpWeight = Math.min(0.85, 0.40 + 0.45 * Math.max(0, 1 - hoursUntilGame / 72));
  const eloWeight   = 1 - sharpWeight;

  return eloProb * eloWeight + sharpHomeProb * sharpWeight;
}

// ── KELLY SIZING ──────────────────────────────────────────────────────────────
function kellySize(fairProb, marketProb) {
  const b     = (1 / marketProb) - 1;  // decimal odds minus 1
  const q     = 1 - fairProb;
  const kelly = (fairProb * b - q) / b;
  const frac  = Math.max(0, kelly * CONFIG.KELLY_FRACTION);
  return Math.min(CONFIG.MAX_BET_USD, frac * (/* bankroll */ 2500));
}

// ── MAIN SCAN LOOP ────────────────────────────────────────────────────────────
async function scan() {
  if (!state.running || state.inCooldown) return;
  await refreshBalance();
  if (state.todayLoss >= CONFIG.DAILY_LOSS_LIMIT) {
    state.running = false;
    pushLog("⛔ Daily loss limit reached — bot halted");
    return;
  }
  if (state.openBets.length >= CONFIG.MAX_CONCURRENT) {
    pushLog(`Max concurrent bets (${CONFIG.MAX_CONCURRENT}) reached — skipping scan`);
    return;
  }

  try {
    const markets = await getKalshiMarkets(CONFIG.KALSHI_API_KEY, CONFIG.KALSHI_PRIVATE_KEY);
    const odds    = await getSharpOdds(CONFIG.ODDS_API_KEY);

    for (const market of markets) {
      const { gameId, homeTeam, awayTeam, homeProb: kalshiHomeProb,
              openInterest, hoursUntilGame } = market;

      // ── FILTER: liquidity gate
      if (openInterest < CONFIG.MIN_LIQUIDITY) {
        pushLog(`SKIP ${homeTeam} — open interest $${openInterest} < $${CONFIG.MIN_LIQUIDITY}`);
        continue;
      }

      // ── FILTER: max hours to game
      if (hoursUntilGame > CONFIG.MAX_HOURS_TO_GAME) {
        pushLog(`SKIP ${homeTeam} vs ${awayTeam} — ${hoursUntilGame.toFixed(1)}h away > ${CONFIG.MAX_HOURS_TO_GAME}h limit`);
        continue;
      }

      // ── FILTER: one bet per game per day
      if (isGameLocked(gameId)) {
        pushLog(`SKIP ${homeTeam} vs ${awayTeam} — already bet today`);
        continue;
      }

      // ── FILTER: max concurrent bets
      if (state.openBets.length >= CONFIG.MAX_CONCURRENT) break;

      // ── COMPUTE FAIR VALUE
      const sharpHome = odds[gameId]?.homeProb ?? kalshiHomeProb;
      const fairHome  = computeFairValue(homeTeam, awayTeam, sharpHome, hoursUntilGame);
      const edge      = fairHome - kalshiHomeProb;

      if (edge * 100 < CONFIG.MIN_EDGE_PCT) continue;

      // ── FIRE BET
      const stake = kellySize(fairHome, kalshiHomeProb);
      pushLog(`SIGNAL ${homeTeam} +${(edge*100).toFixed(1)}% edge · fair ${(fairHome*100).toFixed(1)}¢ · Kalshi ${(kalshiHomeProb*100).toFixed(1)}¢`);

      if (!CONFIG.PAPER_MODE) {
        await placeBet({ gameId, team: homeTeam, stake, apiKeyId: CONFIG.KALSHI_API_KEY, privateKey: CONFIG.KALSHI_PRIVATE_KEY });
        pushLog(`LIVE BET $${stake.toFixed(2)} on ${homeTeam}`);
      } else {
        pushLog(`PAPER BET $${stake.toFixed(2)} on ${homeTeam}`);
      }

      lockGame(gameId);
      await refreshBalance();
      state.openBets.push({ gameId, team: homeTeam, awayTeam, sport: market.sport || 'unknown', stake, edge, fairProb: fairHome, marketProb: kalshiHomeProb });
    }
  } catch (err) {
    pushLog(`ERROR in scan: ${err.message}`, "error");
  }
}

// ── RESULT HANDLER — called when a bet settles ────────────────────────────────
function handleResult(gameId, won) {
  const bet = state.openBets.find(b => b.gameId === gameId);
  if (!bet) return;
  state.openBets = state.openBets.filter(b => b.gameId !== gameId);

  const pnl = won
    ? parseFloat((bet.stake * (1 / bet.marketProb - 1)).toFixed(2))
    : -bet.stake;

  // Refresh balance from Kalshi after settlement
  refreshBalance().catch(() => {});

  state.settledBets.push({
    id:         state.settledBets.length + 1,
    gameId:     gameId,
    team:       bet.team,
    opp:        bet.awayTeam || "",
    sport:      bet.sport || "unknown",
    stake:      bet.stake,
    edge:       bet.edge || 0,
    status:     won ? "WON" : "LOST",
    pnl,
    settledAt:  new Date().toISOString(),
  });

  if (won) {
    state.consecutiveLosses = 0;
    pushLog(`WIN ${bet.team} · +$${pnl.toFixed(2)}`);
  } else {
    state.todayLoss += bet.stake;
    state.consecutiveLosses++;
    pushLog(`LOSS ${bet.team} · -$${bet.stake.toFixed(2)} · consec: ${state.consecutiveLosses}/${CONFIG.MAX_CONSEC_LOSSES}`);

    if (state.consecutiveLosses >= CONFIG.MAX_CONSEC_LOSSES) {
      state.running    = false;
      state.inCooldown = true;
      state.cooldownAt = new Date();
      pushLog(`⏸ COOLDOWN — ${CONFIG.MAX_CONSEC_LOSSES} consecutive losses. Manual restart required.`);
    }
  }
}

function pushLog(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  state.log.push({ t, msg });
  if (state.log.length > 200) state.log.shift();
  console.log(`[${t}] ${msg}`);
}

async function refreshBalance() {
  if (!CONFIG.KALSHI_API_KEY || !CONFIG.KALSHI_PRIVATE_KEY) return;
  try {
    const bal = await getBalance(CONFIG.KALSHI_API_KEY, CONFIG.KALSHI_PRIVATE_KEY);
    if (bal) {
      state.kalshiBalance    = bal.balance;
      state.portfolioValue   = bal.portfolio_value;
      state.balanceUpdatedAt = new Date().toISOString();
      pushLog(`[balance] $${bal.balance.toFixed(2)} available · $${bal.portfolio_value.toFixed(2)} portfolio`);
    }
  } catch (err) {
    pushLog(`[balance] fetch failed: ${err.message}`);
  }
}

// ── EXPRESS API ENDPOINTS (dashboard connects here) ──────────────────────────
app.post("/api/scan", async (req, res) => {
  pushLog("⚡ Manual scan triggered by operator");
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
});─
app.get("/api/state", (req, res) => {
  // Exclude betLockSet (not JSON-serializable)
  const { betLockSet, ...rest } = state;
  res.json(rest);
});
app.get("/api/config", (req, res) => res.json(CONFIG));
app.post("/api/start", async (req, res) => {
  if (state.inCooldown) return res.status(400).json({ error: "In cooldown — clear first" });
  state.running = true;
  pushLog(`Bot STARTED · ${CONFIG.PAPER_MODE ? "PAPER" : "⚠ LIVE"}`);
  await refreshBalance();
  res.json({ ok: true });
});
app.post("/api/stop", (req, res) => {
  state.running = false;
  pushLog("Bot STOPPED by operator");
  res.json({ ok: true });
});
app.post("/api/cooldown/clear", (req, res) => {
  state.inCooldown         = false;
  state.cooldownAt         = null;
  state.consecutiveLosses  = 0;
  state.running            = true;
  pushLog("▶ COOLDOWN CLEARED — restarted by operator");
  res.json({ ok: true });
});
app.get("/api/balance", async (req, res) => {
  try {
    const balance = await getBalance(CONFIG.KALSHI_API_KEY, CONFIG.KALSHI_PRIVATE_KEY);
    pushLog(`[balance] raw response: ${JSON.stringify(balance)}`);
    res.json({ ok: true, balance });
  } catch (err) {
    pushLog(`[balance] ERROR: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/result", (req, res) => {
  const { gameId, won } = req.body;
  handleResult(gameId, won);
  res.json({ ok: true });
});

// ── SCAN INTERVAL ─────────────────────────────────────────────────────────────
setInterval(scan, 60_000); // scan every 60 seconds

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`KalshiBot running on port ${PORT}`);
  // Fetch initial balance on startup
  refreshBalance().catch(() => {});
});
