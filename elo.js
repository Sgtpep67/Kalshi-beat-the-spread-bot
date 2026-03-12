// ─────────────────────────────────────────────────────────────────────────────
// bot/elo.js
// ELO ratings store + win probability engine
//
// Phase 1: Static ratings updated manually each week.
// Phase 2: Call refreshElo(sport) nightly via ESPN hidden API to keep current.
//
// ELO scale: ~1400 (weak) to ~1800 (elite). League average ≈ 1500.
// Home field advantage (HFA) built into eloToWinProb() call — not stored here.
// ─────────────────────────────────────────────────────────────────────────────

// ── STATIC ELO RATINGS ────────────────────────────────────────────────────────
// Last updated: manually. Replace with refreshElo() calls in Phase 2.
// Source: FiveThirtyEight methodology / ESPN power index approximations.

const ELO = {

  // NBA — 2025-26 approximate ratings
  nba: {
    "Boston Celtics":          1742,
    "Oklahoma City Thunder":   1728,
    "Cleveland Cavaliers":     1715,
    "Golden State Warriors":   1698,
    "Denver Nuggets":          1695,
    "Milwaukee Bucks":         1682,
    "LA Clippers":             1671,
    "Phoenix Suns":            1665,
    "New York Knicks":         1660,
    "Dallas Mavericks":        1658,
    "Memphis Grizzlies":       1645,
    "Sacramento Kings":        1640,
    "Philadelphia 76ers":      1635,
    "Miami Heat":              1628,
    "Indiana Pacers":          1620,
    "Minnesota Timberwolves":  1618,
    "New Orleans Pelicans":    1610,
    "LA Lakers":               1608,
    "Orlando Magic":           1600,
    "Chicago Bulls":           1595,
    "Brooklyn Nets":           1580,
    "Atlanta Hawks":           1575,
    "Toronto Raptors":         1565,
    "Houston Rockets":         1560,
    "Utah Jazz":               1540,
    "Portland Trail Blazers":  1530,
    "San Antonio Spurs":       1522,
    "Washington Wizards":      1505,
    "Detroit Pistons":         1498,
    "Charlotte Hornets":       1490,
  },

  // NFL — 2025-26 approximate ratings (post-week 18)
  nfl: {
    "Kansas City Chiefs":      1748,
    "Baltimore Ravens":        1720,
    "Philadelphia Eagles":     1712,
    "San Francisco 49ers":     1705,
    "Detroit Lions":           1698,
    "Buffalo Bills":           1692,
    "Houston Texans":          1678,
    "Dallas Cowboys":          1665,
    "Cincinnati Bengals":      1658,
    "Miami Dolphins":          1645,
    "Cleveland Browns":        1638,
    "Jacksonville Jaguars":    1628,
    "Pittsburgh Steelers":     1620,
    "Los Angeles Rams":        1615,
    "Seattle Seahawks":        1608,
    "Green Bay Packers":       1602,
    "Minnesota Vikings":       1598,
    "New York Jets":           1590,
    "Las Vegas Raiders":       1580,
    "Denver Broncos":          1575,
    "Indianapolis Colts":      1568,
    "Tampa Bay Buccaneers":    1562,
    "New Orleans Saints":      1555,
    "Atlanta Falcons":         1548,
    "Chicago Bears":           1540,
    "New England Patriots":    1530,
    "Los Angeles Chargers":    1525,
    "New York Giants":         1515,
    "Tennessee Titans":        1508,
    "Arizona Cardinals":       1498,
    "Washington Commanders":   1492,
    "Carolina Panthers":       1480,
  },

  // MLB — 2025 approximate ratings
  mlb: {
    "Los Angeles Dodgers":     1720,
    "Atlanta Braves":          1698,
    "Houston Astros":          1688,
    "New York Yankees":        1678,
    "Philadelphia Phillies":   1665,
    "Cleveland Guardians":     1652,
    "Baltimore Orioles":       1645,
    "Texas Rangers":           1638,
    "San Diego Padres":        1628,
    "Seattle Mariners":        1620,
    "Toronto Blue Jays":       1612,
    "Boston Red Sox":          1605,
    "Chicago Cubs":            1598,
    "Milwaukee Brewers":       1590,
    "Minnesota Twins":         1582,
    "New York Mets":           1575,
    "Arizona Diamondbacks":    1568,
    "Tampa Bay Rays":          1560,
    "Detroit Tigers":          1548,
    "San Francisco Giants":    1540,
    "Miami Marlins":           1530,
    "Pittsburgh Pirates":      1520,
    "St. Louis Cardinals":     1515,
    "Chicago White Sox":       1505,
    "Kansas City Royals":      1498,
    "Washington Nationals":    1488,
    "Cincinnati Reds":         1480,
    "Los Angeles Angels":      1472,
    "Oakland Athletics":       1460,
    "Colorado Rockies":        1448,
  },

  // NHL — 2025-26 approximate ratings
  nhl: {
    "Colorado Avalanche":      1715,
    "Boston Bruins":           1702,
    "Carolina Hurricanes":     1695,
    "Tampa Bay Lightning":     1688,
    "Toronto Maple Leafs":     1680,
    "Vegas Golden Knights":    1672,
    "Florida Panthers":        1665,
    "Dallas Stars":            1658,
    "New Jersey Devils":       1648,
    "Edmonton Oilers":         1640,
    "New York Rangers":        1632,
    "Minnesota Wild":          1625,
    "Calgary Flames":          1618,
    "Seattle Kraken":          1610,
    "Pittsburgh Penguins":     1602,
    "Washington Capitals":     1595,
    "Vancouver Canucks":       1588,
    "Nashville Predators":     1580,
    "Winnipeg Jets":           1572,
    "Ottawa Senators":         1565,
    "Philadelphia Flyers":     1555,
    "Los Angeles Kings":       1548,
    "St. Louis Blues":         1540,
    "Detroit Red Wings":       1530,
    "New York Islanders":      1522,
    "Buffalo Sabres":          1512,
    "Montreal Canadiens":      1505,
    "Anaheim Ducks":           1490,
    "Arizona Coyotes":         1478,
    "Columbus Blue Jackets":   1468,
    "San Jose Sharks":         1452,
    "Chicago Blackhawks":      1440,
  },

  // NCAAB — top 64 programs by historical power rating
  ncaab: {
    "Duke Blue Devils":              1740,
    "Kansas Jayhawks":               1732,
    "Kentucky Wildcats":             1725,
    "North Carolina Tar Heels":      1718,
    "Connecticut Huskies":           1710,
    "Gonzaga Bulldogs":              1702,
    "Houston Cougars":               1695,
    "Purdue Boilermakers":           1688,
    "Arizona Wildcats":              1680,
    "Tennessee Volunteers":          1672,
    "Auburn Tigers":                 1665,
    "Alabama Crimson Tide":          1658,
    "Marquette Golden Eagles":       1650,
    "Creighton Bluejays":            1642,
    "Michigan State Spartans":       1635,
    "Florida Gators":                1628,
    "Indiana Hoosiers":              1620,
    "Iowa Hawkeyes":                 1612,
    "Baylor Bears":                  1605,
    "UCLA Bruins":                   1598,
    "Villanova Wildcats":            1590,
    "Texas Longhorns":               1582,
    "Wisconsin Badgers":             1575,
    "Ohio State Buckeyes":           1568,
    "Xavier Musketeers":             1560,
    "San Diego State Aztecs":        1552,
    "Missouri Tigers":               1545,
    "Illinois Fighting Illini":      1538,
    "Oregon Ducks":                  1530,
    "Oklahoma Sooners":              1522,
  },

  // NCAAF — top 32 programs
  ncaaf: {
    "Georgia Bulldogs":              1748,
    "Alabama Crimson Tide":          1735,
    "Ohio State Buckeyes":           1722,
    "Michigan Wolverines":           1710,
    "Clemson Tigers":                1698,
    "Texas Longhorns":               1685,
    "Oregon Ducks":                  1672,
    "Penn State Nittany Lions":      1660,
    "Notre Dame Fighting Irish":     1648,
    "Florida State Seminoles":       1635,
    "Oklahoma Sooners":              1622,
    "USC Trojans":                   1610,
    "Tennessee Volunteers":          1598,
    "LSU Tigers":                    1585,
    "Texas A&M Aggies":              1572,
    "Utah Utes":                     1560,
    "Washington Huskies":            1548,
    "Kansas State Wildcats":         1535,
    "Ole Miss Rebels":               1522,
    "Miami Hurricanes":              1510,
    "Boise State Broncos":           1498,
    "TCU Horned Frogs":              1485,
    "Iowa Hawkeyes":                 1472,
    "Louisville Cardinals":          1460,
    "Oklahoma State Cowboys":        1448,
    "Pittsburgh Panthers":           1435,
    "Air Force Falcons":             1422,
    "Colorado Buffaloes":            1410,
    "Missouri Tigers":               1398,
    "Wisconsin Badgers":             1385,
  },
};

// ── HOME FIELD ADVANTAGE (in ELO points) ──────────────────────────────────────
// These values are added to the home team's ELO before computing win probability.
// Source: historical game data analysis.
const HFA = {
  nba:   65,   // ~3-4 point equivalent
  nfl:   55,   // ~2.5-3 point equivalent  
  mlb:   30,   // baseball HFA is smaller
  nhl:   40,   // moderate rink advantage
  ncaab: 90,   // college basketball — biggest HFA in sports
  ncaaf: 75,   // college football — loud home crowds
};

// ── CORE FUNCTIONS ─────────────────────────────────────────────────────────────

/**
 * Get ELO rating for a team. Returns league average (1500) if team not found.
 * @param {string} teamName  - Exact team name as it appears in ELO object above
 * @param {string} sport     - 'nba' | 'nfl' | 'mlb' | 'nhl' | 'ncaab' | 'ncaaf'
 * @returns {number} ELO rating
 */
function getElo(teamName, sport) {
  const leagueRatings = ELO[sport] || {};

  // Try exact match first
  if (leagueRatings[teamName] !== undefined) {
    return leagueRatings[teamName];
  }

  // Try case-insensitive partial match (handles "Celtics" matching "Boston Celtics")
  const lower = teamName.toLowerCase();
  const match = Object.entries(leagueRatings).find(([name]) =>
    name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase().split(" ").pop())
  );

  if (match) return match[1];

  // Fallback: league average
  console.warn(`[elo] Unknown team "${teamName}" (${sport}) — using league average 1500`);
  return 1500;
}

/**
 * Convert ELO ratings to win probability for the home team.
 * Uses standard logistic function with home field advantage baked in.
 *
 * Formula: P(home) = 1 / (1 + 10^(-(ELO_home - ELO_away + HFA) / 400))
 *
 * @param {number} homeElo  - Home team ELO rating
 * @param {number} awayElo  - Away team ELO rating
 * @param {number} hfa      - Home field advantage in ELO points
 * @returns {number} Probability home team wins (0.0 – 1.0)
 */
function eloToWinProb(homeElo, awayElo, hfa = 65) {
  return 1 / (1 + Math.pow(10, -(homeElo - awayElo + hfa) / 400));
}

/**
 * Get home win probability directly from team names and sport.
 * Convenience wrapper combining getElo() + eloToWinProb().
 *
 * @param {string} homeTeam  - Home team name
 * @param {string} awayTeam  - Away team name
 * @param {string} sport     - Sport identifier
 * @returns {number} Home win probability (0.0 – 1.0)
 */
function getHomeWinProb(homeTeam, awayTeam, sport) {
  const homeElo = getElo(homeTeam, sport);
  const awayElo = getElo(awayTeam, sport);
  const hfa     = HFA[sport] ?? 65;
  return eloToWinProb(homeElo, awayElo, hfa);
}

// ── PHASE 2: LIVE ESPN REFRESH ─────────────────────────────────────────────────
// Uncomment and call refreshElo('nba') nightly once you're on Phase 2.
// ESPN's hidden power index API — no key required but subject to change.
//
// const axios = require('axios');
// const ESPN_SPORT_MAP = {
//   nba:   'basketball/nba',
//   nfl:   'football/nfl',
//   mlb:   'baseball/mlb',
//   nhl:   'hockey/nhl',
// };
//
// async function refreshElo(sport) {
//   const path = ESPN_SPORT_MAP[sport];
//   if (!path) return;
//   try {
//     const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/teams?limit=32`;
//     const res = await axios.get(url, { timeout: 8000 });
//     const teams = res.data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
//     teams.forEach(({ team }) => {
//       const powerIdx = team.record?.items?.[0]?.stats
//         ?.find(s => s.name === 'playoffSeed' || s.name === 'leagueWinPercent')
//         ?.value;
//       if (powerIdx !== undefined && team.displayName) {
//         // Map ESPN power index (0.0–1.0) to ELO scale (1400–1800)
//         ELO[sport][team.displayName] = 1400 + (powerIdx * 400);
//       }
//     });
//     console.log(`[elo] Refreshed ${Object.keys(ELO[sport]).length} ${sport.toUpperCase()} ratings`);
//   } catch (err) {
//     console.error(`[elo] ESPN refresh failed for ${sport}:`, err.message);
//   }
// }

module.exports = { getElo, eloToWinProb, getHomeWinProb, ELO, HFA };
