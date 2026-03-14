var axios = require("axios");

var BASE_URL = "https://api.the-odds-api.com/v4";

var TARGET_BOOKS = ["pinnacle", "draftkings", "fanduel", "betmgm"];

var SPORT_MAP = {
  nba:    "basketball_nba",
  nfl:    "americanfootball_nfl",
  mlb:    "baseball_mlb",
  nhl:    "icehockey_nhl",
  ncaab:  "basketball_ncaab",
  ncaaf:  "americanfootball_ncaaf",
  ncaabb: "baseball_ncaa",
  ncaah:  "icehockey_college_hockey",
  wnba:   "basketball_wnba",
};

function americanToDecimal(american) {
  if (american >= 100) return (american / 100) + 1;
  return (100 / Math.abs(american)) + 1;
}

function devig(rawHome, rawAway) {
  var total = rawHome + rawAway;
  return { home: rawHome / total, away: rawAway / total };
}

async function getSharpOdds(apiKey, sport) {
  if (!apiKey) {
    console.log("[odds] No ODDS_API_KEY set  skipping");
    return {};
  }
  var sportKey = SPORT_MAP[sport];
  if (!sportKey) {
    console.log("[odds] Unknown sport: " + sport);
    return {};
  }

  var response;
  try {
    response = await axios.get(BASE_URL + "/sports/" + sportKey + "/odds", {
      timeout: 10000,
      params: {
        apiKey:      apiKey,
        regions:     "us",
        markets:     "h2h",
        bookmakers:  TARGET_BOOKS.join(","),
        oddsFormat:  "american",
      },
    });
  } catch(err) {
    var status = err.response ? err.response.status : null;
    if (status === 401) console.log("[odds] Invalid API key");
    else if (status === 422) console.log("[odds] Sport not available right now: " + sport);
    else if (status === 429) console.log("[odds] Rate limit hit");
    else console.log("[odds] Fetch error for " + sport + ": " + err.message);
    return {};
  }

  var games  = response.data || [];
  var result = {};

  var remaining = response.headers ? response.headers["x-requests-remaining"] : null;
  if (remaining != null) console.log("[odds] API calls remaining: " + remaining);

  for (var i = 0; i < games.length; i++) {
    var game      = games[i];
    var homeTeam  = game.home_team;
    var awayTeam  = game.away_team;
    var homeProbs = [];

    var bookmakers = game.bookmakers || [];
    for (var j = 0; j < bookmakers.length; j++) {
      var bm     = bookmakers[j];
      var market = null;
      var mkts   = bm.markets || [];
      for (var k = 0; k < mkts.length; k++) {
        if (mkts[k].key === "h2h") { market = mkts[k]; break; }
      }
      if (!market) continue;

      var homeOut = null;
      var awayOut = null;
      var outcomes = market.outcomes || [];
      for (var l = 0; l < outcomes.length; l++) {
        if (outcomes[l].name === homeTeam) homeOut = outcomes[l];
        if (outcomes[l].name === awayTeam) awayOut = outcomes[l];
      }
      if (!homeOut || !awayOut) continue;

      try {
        var rawHome = 1 / americanToDecimal(homeOut.price);
        var rawAway = 1 / americanToDecimal(awayOut.price);
        homeProbs.push(devig(rawHome, rawAway).home);
      } catch(e) { /* skip bad line */ }
    }

    if (homeProbs.length === 0) continue;

    var avgHome = homeProbs.reduce(function(a, b) { return a + b; }, 0) / homeProbs.length;
    result[game.id] = {
      homeTeam:     homeTeam,
      awayTeam:     awayTeam,
      homeProb:     avgHome,
      awayProb:     1 - avgHome,
      booksUsed:    homeProbs.length,
      commenceTime: game.commence_time,
    };
  }

  console.log("[odds] " + sport.toUpperCase() + ": " + Object.keys(result).length + " games");
  return result;
}

async function getSharpOddsMulti(apiKey, sports) {
  if (!apiKey) {
    console.log("[odds] No ODDS_API_KEY  cannot fetch sharp lines");
    return {};
  }

  var promises = sports.map(function(sport) {
    return getSharpOdds(apiKey, sport).catch(function() { return {}; });
  });

  var results = await Promise.all(promises);
  var merged  = {};
  results.forEach(function(r) { Object.assign(merged, r); });
  console.log("[odds] Total games across all sports: " + Object.keys(merged).length);
  return merged;
}

module.exports = { getSharpOdds, getSharpOddsMulti, americanToDecimal, devig, SPORT_MAP };
