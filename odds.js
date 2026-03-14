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
    console.log("[odds] No ODDS_API_KEY set");
    return {};
  }
  var sportKey = SPORT_MAP[sport];
  if (!sportKey) {
    console.log("[odds] Unknown sport: " + sport);
    return {};
  }
  console.log("[odds] Fetching " + sport + " => " + sportKey);

  var response;
  try {
    response = await axios.get(BASE_URL + "/sports/" + sportKey + "/odds", {
      timeout: 10000,
      params: {
        apiKey:     apiKey,
        regions:    "us",
        markets:    "h2h",
        bookmakers: TARGET_BOOKS.join(","),
        oddsFormat: "american",
      },
    });
  } catch(err) {
    var status = err.response ? err.response.status : null;
    var body   = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0,200) : "";
    console.log("[odds] " + sport + " error " + status + ": " + err.message + " " + body);
    return {};
  }

  var games  = response.data || [];
  var result = {};
  var rem    = response.headers ? response.headers["x-requests-remaining"] : null;
  if (rem != null) console.log("[odds] API calls remaining: " + rem);
  console.log("[odds] " + sport + " raw games returned: " + games.length);

  for (var i = 0; i < games.length; i++) {
    var game      = games[i];
    var homeTeam  = game.home_team;
    var awayTeam  = game.away_team;
    var homeProbs = [];
    var bookmakers = game.bookmakers || [];

    for (var j = 0; j < bookmakers.length; j++) {
      var bm   = bookmakers[j];
      var mkts = bm.markets || [];
      var mkt  = null;
      for (var k = 0; k < mkts.length; k++) {
        if (mkts[k].key === "h2h") { mkt = mkts[k]; break; }
      }
      if (!mkt) continue;
      var homeOut = null;
      var awayOut = null;
      var outcomes = mkt.outcomes || [];
      for (var l = 0; l < outcomes.length; l++) {
        if (outcomes[l].name === homeTeam) homeOut = outcomes[l];
        if (outcomes[l].name === awayTeam) awayOut = outcomes[l];
      }
      if (!homeOut || !awayOut) continue;
      try {
        var rawHome = 1 / americanToDecimal(homeOut.price);
        var rawAway = 1 / americanToDecimal(awayOut.price);
        homeProbs.push(devig(rawHome, rawAway).home);
      } catch(e) {}
    }

    if (homeProbs.length === 0) continue;
    var avg = homeProbs.reduce(function(a, b) { return a + b; }, 0) / homeProbs.length;
    result[game.id] = {
      homeTeam:     homeTeam,
      awayTeam:     awayTeam,
      homeProb:     avg,
      awayProb:     1 - avg,
      booksUsed:    homeProbs.length,
      commenceTime: game.commence_time,
    };
  }

  console.log("[odds] " + sport.toUpperCase() + " parsed: " + Object.keys(result).length + " games");
  return result;
}

async function getSharpOddsMulti(apiKey, sports) {
  if (!apiKey) {
    console.log("[odds] No ODDS_API_KEY");
    return {};
  }
  var merged = {};
  for (var i = 0; i < sports.length; i++) {
    try {
      var r = await getSharpOdds(apiKey, sports[i]);
      Object.assign(merged, r);
    } catch(err) {
      console.log("[odds] " + sports[i] + " failed: " + err.message);
    }
  }
  console.log("[odds] Total: " + Object.keys(merged).length + " games");
  return merged;
}

module.exports = { getSharpOdds, getSharpOddsMulti, americanToDecimal, devig, SPORT_MAP };
