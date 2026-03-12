// ─────────────────────────────────────────────────────────────────────────────
// bot/odds.js
// The Odds API client — fetches sharp sportsbook consensus odds and deviggs them
// into true win probabilities.
//
// Books used (in order of sharpness):
//   1. Pinnacle    — sharpest book, accepts sharp action, tightest lines
//   2. DraftKings  — large US book, generally efficient
//   3. FanDuel     — large US book, generally efficient
//   4. BetMGM      — major US book
//
// API docs: https://the-odds-api.com/liveapi/guides/v4/
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const BASE_URL = "https://api.the-odds-api.com/v4";

// Books to fetch — Pinnacle is sharpest but may not always be available
const TARGET_BOOKS = ["pinnacle", "draftkings", "fanduel", "betmgm"];

// Kalshi sport identifiers → Odds API sport keys
const SPORT_MAP = {
  nba:   "basketball_nba",
  nfl:   "americanfootball_nfl",
  mlb:   "baseball_mlb",
  nhl:   "icehockey_nhl",
  ncaab: "basketball_ncaab",
  ncaaf: "americanfootball_ncaaf",
};

// ── HELPERS ────────────────────────────────────────────────────────────────────

/**
 * Convert American moneyline odds to decimal odds.
 * e.g. -110 → 1.909,  +150 → 2.500
 */
function americanToDecimal(american) {
  if (american >= 100)  return (american / 100) + 1;
  if (american < 0)     return (100 / Math.abs(american)) + 1;
  throw new Error(`Invalid American odds: ${american}`);
}

/**
 * Devig two raw implied probabilities using the proportional method.
 * Removes the bookmaker's overround so probabilities sum to exactly 1.0.
 *
 * Example:
 *   raw_home = 1 / decimal(home_ml) = 0.524
 *   raw_away = 1 / decimal(away_ml) = 0.524
 *   true_home = 0.524 / (0.524 + 0.524) = 0.500
 *
 * @param {number} rawHome  - Raw implied probability for home team
 * @param {number} rawAway  - Raw implied probability for away team
 * @returns {{ home: number, away: number }} True devigged probabilities
 */
function devig(rawHome, rawAway) {
  const total = rawHome + rawAway;
  return {
    home: rawHome / total,
    away: rawAway / total,
  };
}

/**
 * Extract the home and away team names from an Odds API game object.
 * The API returns home_team and away_team as strings.
 */
function parseTeams(game) {
  return {
    homeTeam: game.home_team,
    awayTeam: game.away_team,
  };
}

// ── MAIN EXPORT ────────────────────────────────────────────────────────────────

/**
 * Fetch sharp consensus odds for all games in a given sport.
 * Returns a map of gameId → { homeProb, awayProb, gamesFound, booksUsed }
 *
 * @param {string} apiKey  - The Odds API key (from ODDS_API_KEY env var)
 * @param {string} sport   - Sport identifier: 'nba' | 'nfl' | 'mlb' | 'nhl' | 'ncaab' | 'ncaaf'
 * @returns {Promise<Object>} Map of game IDs to consensus probabilities
 */
async function getSharpOdds(apiKey, sport) {
  const sportKey = SPORT_MAP[sport];
  if (!sportKey) {
    console.warn(`[odds] Unknown sport "${sport}" — skipping odds fetch`);
    return {};
  }

  let response;
  try {
    response = await axios.get(`${BASE_URL}/sports/${sportKey}/odds`, {
      timeout: 10000,
      params: {
        apiKey,
        regions:     "us",
        markets:     "h2h",                     // moneyline only
        bookmakers:  TARGET_BOOKS.join(","),
        oddsFormat:  "american",
      },
    });
  } catch (err) {
    if (err.response?.status === 401) {
      console.error("[odds] Invalid API key — check ODDS_API_KEY env var");
    } else if (err.response?.status === 429) {
      console.error("[odds] Rate limit hit — too many requests this month");
    } else {
      console.error("[odds] Fetch error:", err.message);
    }
    return {};
  }

  const games  = response.data ?? [];
  const result = {};

  // Log how many API calls remain this month
  const remaining = response.headers?.["x-requests-remaining"];
  if (remaining !== undefined) {
    console.log(`[odds] API calls remaining this month: ${remaining}`);
  }

  for (const game of games) {
    const { homeTeam, awayTeam } = parseTeams(game);
    const homeProbs = [];

    for (const bookmaker of (game.bookmakers ?? [])) {
      const market = bookmaker.markets?.find(m => m.key === "h2h");
      if (!market) continue;

      const homeOutcome = market.outcomes.find(o => o.name === game.home_team);
      const awayOutcome = market.outcomes.find(o => o.name === game.away_team);

      if (!homeOutcome || !awayOutcome) continue;

      try {
        const rawHome = 1 / americanToDecimal(homeOutcome.price);
        const rawAway = 1 / americanToDecimal(awayOutcome.price);
        const { home } = devig(rawHome, rawAway);
        homeProbs.push(home);
      } catch (e) {
        console.warn(`[odds] Failed to parse odds for ${homeTeam} from ${bookmaker.key}:`, e.message);
      }
    }

    if (homeProbs.length === 0) {
      console.warn(`[odds] No valid odds found for ${homeTeam} vs ${awayTeam}`);
      continue;
    }

    // Average across all available books
    const avgHomeProb = homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length;

    result[game.id] = {
      homeTeam,
      awayTeam,
      homeProb:   avgHomeProb,
      awayProb:   1 - avgHomeProb,
      booksUsed:  homeProbs.length,
      commenceTime: game.commence_time,
    };
  }

  console.log(`[odds] Fetched ${Object.keys(result).length} ${sport.toUpperCase()} games from The Odds API`);
  return result;
}

/**
 * Fetch odds for multiple sports at once.
 * Returns a merged map of all game IDs across all sports.
 *
 * @param {string} apiKey      - The Odds API key
 * @param {string[]} sports    - Array of sport identifiers e.g. ['nba', 'nfl']
 * @returns {Promise<Object>}
 */
async function getSharpOddsMulti(apiKey, sports) {
  const results = await Promise.allSettled(
    sports.map(sport => getSharpOdds(apiKey, sport))
  );

  const merged = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      Object.assign(merged, r.value);
    } else {
      console.error(`[odds] Failed to fetch ${sports[i]}:`, r.reason?.message);
    }
  });

  return merged;
}

module.exports = { getSharpOdds, getSharpOddsMulti, americanToDecimal, devig, SPORT_MAP };
