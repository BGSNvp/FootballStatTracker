/*
 * Stat engine: turns the raw play log into team totals, player lines,
 * drive summaries and live trend series. Pure functions, no Firebase.
 *
 * Play record shape (all fields optional unless noted):
 *   seq        number   monotonic order (required)
 *   team       'home'|'away'  team on offense (required)
 *   quarter    1..5     (5 = OT)
 *   playType   'run'|'pass'|'sack'|'kneel'|'spike'|'punt'|'kickoff'|'fg'|'xp'|'2pt'|'penalty'
 *   down       1..4
 *   distance   number   yards to go
 *   yardLine   number   0..100, yards from own goal line
 *   yards      number   yards gained (negative = loss)
 *   complete   bool     pass completions
 *   passer / rusher / receiver / returner / kicker   player id
 *   tacklers   [playerId]  defenders credited (defending team)
 *   sackBy     playerId
 *   intBy      playerId
 *   ffBy       playerId
 *   touchdown  bool
 *   firstDown  bool
 *   turnover   'int'|'fumble'|'downs'|null
 *   good       bool     kick attempt result (fg/xp/2pt)
 *   penaltyOn  'home'|'away'
 *   penaltyYards number
 *   noPlay     bool     penalty wiped the play out (excluded from totals)
 */

export const OFFENSE_TYPES = ["run", "pass", "sack", "kneel", "spike"];
export const SCRIMMAGE_TYPES = ["run", "pass", "sack"];

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

export function isCountedPlay(p) {
  return !p.noPlay && SCRIMMAGE_TYPES.includes(p.playType);
}

/** A play is "successful" by the standard down-based efficiency definition. */
export function isSuccessful(p) {
  if (!isCountedPlay(p)) return false;
  const y = num(p.yards);
  const dist = num(p.distance) || 10;
  const down = num(p.down) || 1;
  if (p.touchdown) return true;
  if (down === 1) return y >= Math.min(4, dist) || y >= 0.4 * dist;
  if (down === 2) return y >= 0.6 * dist;
  return y >= dist;
}

export function pointsFor(p) {
  if (p.noPlay) return 0;
  if (p.touchdown) return 6;
  if (p.playType === "fg" && p.good) return 3;
  if (p.playType === "xp" && p.good) return 1;
  if (p.playType === "2pt" && p.good) return 2;
  return 0;
}

function emptyTeam() {
  return {
    points: 0,
    plays: 0, totalYards: 0, yardsPerPlay: 0,
    rushAtt: 0, rushYards: 0, rushYPC: 0, rushTD: 0,
    passAtt: 0, passComp: 0, passYards: 0, passTD: 0, passInt: 0,
    compPct: 0, passYPA: 0,
    sacksTaken: 0, sackYards: 0,
    firstDowns: 0, explosive: 0, negative: 0,
    successPlays: 0, successRate: 0,
    thirdAtt: 0, thirdConv: 0, thirdPct: 0,
    fourthAtt: 0, fourthConv: 0, fourthPct: 0,
    turnovers: 0, fumblesLost: 0, penalties: 0, penaltyYards: 0,
    redZoneTrips: 0, redZoneTD: 0,
    runPlays: 0, passPlays: 0, runPct: 0,
    drives: 0, scoringDrives: 0, yardsPerDrive: 0, playsPerDrive: 0,
    // defensive production (credited to this team while it is on defense)
    defTackles: 0, defSacks: 0, defInt: 0, defFF: 0, defTFL: 0,
    yardsAllowed: 0, playsAllowed: 0, yardsPerPlayAllowed: 0
  };
}

const other = (team) => (team === "home" ? "away" : "home");

/** Assign a drive number to every play: possession change or a scoring/kick play ends a drive. */
export function withDrives(plays) {
  let driveNo = 0;
  let prevTeam = null;
  let boundary = true;
  return plays.map((p) => {
    if (prevTeam !== null && p.team !== prevTeam) boundary = true;
    // A conversion attempt belongs to the drive that scored, not a new one.
    if (boundary && !["xp", "2pt"].includes(p.playType)) {
      driveNo += 1;
      boundary = false;
    }
    prevTeam = p.team;
    const out = { ...p, drive: driveNo };
    if (
      p.touchdown || p.turnover ||
      ["punt", "fg", "kickoff", "xp", "2pt"].includes(p.playType)
    ) {
      boundary = true;
    }
    return out;
  });
}

export function computeDrives(plays) {
  const withD = withDrives(plays);
  const byDrive = new Map();
  withD.forEach((p) => {
    if (!byDrive.has(p.drive)) {
      byDrive.set(p.drive, {
        drive: p.drive, team: p.team, quarter: p.quarter || 1,
        plays: 0, yards: 0, points: 0, result: "—",
        startYard: typeof p.yardLine === "number" ? p.yardLine : null,
        firstDowns: 0
      });
    }
    const d = byDrive.get(p.drive);
    if (isCountedPlay(p)) {
      d.plays += 1;
      d.yards += num(p.yards);
    }
    if (p.firstDown) d.firstDowns += 1;
    d.points += pointsFor(p);
    if (p.touchdown) d.result = "Touchdown";
    else if (p.playType === "fg") d.result = p.good ? "Field goal" : "Missed FG";
    else if (p.turnover === "int") d.result = "Interception";
    else if (p.turnover === "fumble") d.result = "Fumble";
    else if (p.turnover === "downs") d.result = "Turnover on downs";
    else if (p.playType === "punt") d.result = "Punt";
    else if (p.playType === "kneel") d.result = "End of half";
  });
  // Drop bookkeeping-only drives (e.g. a lone dead-ball penalty).
  return [...byDrive.values()].filter((d) => d.plays > 0 || d.points > 0);
}

export function computeTeamStats(plays) {
  const totals = { home: emptyTeam(), away: emptyTeam() };
  const withD = withDrives(plays);
  const rzTrips = { home: new Set(), away: new Set() };
  const rzTD = { home: new Set(), away: new Set() };
  const driveIds = { home: new Set(), away: new Set() };
  const scoringDrives = { home: new Set(), away: new Set() };

  withD.forEach((p) => {
    const t = totals[p.team];
    const d = totals[other(p.team)];
    if (!t) return;

    t.points += pointsFor(p);

    if (p.playType === "penalty" || num(p.penaltyYards)) {
      const on = p.penaltyOn || p.team;
      if (totals[on]) {
        totals[on].penalties += 1;
        totals[on].penaltyYards += num(p.penaltyYards);
      }
    }

    if (p.noPlay) return;

    if (SCRIMMAGE_TYPES.includes(p.playType)) {
      driveIds[p.team].add(p.drive);
      if (num(p.yardLine) >= 80) rzTrips[p.team].add(p.drive);
      if (p.touchdown && num(p.yardLine) >= 80) rzTD[p.team].add(p.drive);
    }
    if (pointsFor(p) > 0) scoringDrives[p.team].add(p.drive);

    if (isCountedPlay(p)) {
      const y = num(p.yards);
      t.plays += 1;
      t.totalYards += y;
      d.playsAllowed += 1;
      d.yardsAllowed += y;
      if (isSuccessful(p)) t.successPlays += 1;
      if (y >= 15) t.explosive += 1;
      if (y < 0) t.negative += 1;
      const down = num(p.down);
      if (down === 3) {
        t.thirdAtt += 1;
        if (p.firstDown || p.touchdown) t.thirdConv += 1;
      } else if (down === 4) {
        t.fourthAtt += 1;
        if (p.firstDown || p.touchdown) t.fourthConv += 1;
      }
    }

    if (p.firstDown) t.firstDowns += 1;

    if (p.playType === "run") {
      t.runPlays += 1;
      t.rushAtt += 1;
      t.rushYards += num(p.yards);
      if (p.touchdown) t.rushTD += 1;
    } else if (p.playType === "pass") {
      t.passPlays += 1;
      t.passAtt += 1;
      if (p.complete) {
        t.passComp += 1;
        t.passYards += num(p.yards);
        if (p.touchdown) t.passTD += 1;
      }
      if (p.turnover === "int") t.passInt += 1;
    } else if (p.playType === "sack") {
      t.passPlays += 1;
      t.sacksTaken += 1;
      t.sackYards += Math.abs(num(p.yards));
      d.defSacks += 1;
    }

    if (p.turnover === "int" || p.turnover === "fumble" || p.turnover === "downs") {
      t.turnovers += 1;
      if (p.turnover === "fumble") t.fumblesLost += 1;
    }

    (p.tacklers || []).forEach(() => { d.defTackles += 1; });
    if (p.intBy) d.defInt += 1;
    if (p.ffBy) d.defFF += 1;
    if (isCountedPlay(p) && num(p.yards) < 0) d.defTFL += 1;
  });

  ["home", "away"].forEach((k) => {
    const t = totals[k];
    t.drives = driveIds[k].size;
    t.scoringDrives = scoringDrives[k].size;
    t.redZoneTrips = rzTrips[k].size;
    t.redZoneTD = rzTD[k].size;
    t.yardsPerPlay = t.plays ? t.totalYards / t.plays : 0;
    t.rushYPC = t.rushAtt ? t.rushYards / t.rushAtt : 0;
    t.compPct = t.passAtt ? (100 * t.passComp) / t.passAtt : 0;
    t.passYPA = t.passAtt ? t.passYards / t.passAtt : 0;
    t.successRate = t.plays ? (100 * t.successPlays) / t.plays : 0;
    t.thirdPct = t.thirdAtt ? (100 * t.thirdConv) / t.thirdAtt : 0;
    t.fourthPct = t.fourthAtt ? (100 * t.fourthConv) / t.fourthAtt : 0;
    const rp = t.runPlays + t.passPlays;
    t.runPct = rp ? (100 * t.runPlays) / rp : 0;
    t.yardsPerDrive = t.drives ? t.totalYards / t.drives : 0;
    t.playsPerDrive = t.drives ? t.plays / t.drives : 0;
    t.yardsPerPlayAllowed = t.playsAllowed ? t.yardsAllowed / t.playsAllowed : 0;
  });

  return totals;
}

function emptyPlayer(id, info) {
  return {
    id,
    num: info ? info.num : "",
    name: info ? info.name : id,
    pos: info ? info.pos : "",
    rushAtt: 0, rushYards: 0, rushTD: 0, rushYPC: 0, rushLong: 0,
    targets: 0, rec: 0, recYards: 0, recTD: 0, recYPC: 0, recLong: 0,
    passAtt: 0, passComp: 0, passYards: 0, passTD: 0, passInt: 0, compPct: 0, passYPA: 0,
    tackles: 0, sacks: 0, ints: 0, ff: 0, tfl: 0,
    touches: 0, allPurpose: 0, successPlays: 0, successRate: 0, opportunities: 0
  };
}

/** rosters: { home: [{id,num,name,pos}], away: [...] } */
export function computePlayerStats(plays, rosters) {
  const index = {};
  ["home", "away"].forEach((team) => {
    index[team] = {};
    ((rosters && rosters[team]) || []).forEach((pl) => { index[team][pl.id] = pl; });
  });
  const out = { home: {}, away: {} };
  const get = (team, id) => {
    if (!out[team][id]) out[team][id] = emptyPlayer(id, index[team][id]);
    return out[team][id];
  };

  plays.forEach((p) => {
    if (p.noPlay) return;
    const off = p.team;
    const def = other(off);
    const y = num(p.yards);

    if (p.playType === "run" && p.rusher) {
      const r = get(off, p.rusher);
      r.rushAtt += 1; r.rushYards += y; r.touches += 1; r.allPurpose += y;
      r.opportunities += 1;
      if (isSuccessful(p)) r.successPlays += 1;
      if (y > r.rushLong) r.rushLong = y;
      if (p.touchdown) r.rushTD += 1;
    }
    if (p.playType === "pass") {
      if (p.passer) {
        const q = get(off, p.passer);
        q.passAtt += 1;
        q.opportunities += 1;
        if (isSuccessful(p)) q.successPlays += 1;
        if (p.complete) { q.passComp += 1; q.passYards += y; if (p.touchdown) q.passTD += 1; }
        if (p.turnover === "int") q.passInt += 1;
      }
      if (p.receiver) {
        const w = get(off, p.receiver);
        w.targets += 1;
        if (p.complete) {
          w.rec += 1; w.recYards += y; w.touches += 1; w.allPurpose += y;
          w.opportunities += 1;
          if (isSuccessful(p)) w.successPlays += 1;
          if (y > w.recLong) w.recLong = y;
          if (p.touchdown) w.recTD += 1;
        }
      }
    }
    if (p.playType === "sack" && p.sackBy) get(def, p.sackBy).sacks += 1;
    (p.tacklers || []).forEach((id) => {
      const t = get(def, id);
      t.tackles += 1;
      if (isCountedPlay(p) && y < 0) t.tfl += 1;
    });
    if (p.intBy) get(def, p.intBy).ints += 1;
    if (p.ffBy) get(def, p.ffBy).ff += 1;
  });

  const finish = (pl) => {
    pl.rushYPC = pl.rushAtt ? pl.rushYards / pl.rushAtt : 0;
    pl.recYPC = pl.rec ? pl.recYards / pl.rec : 0;
    pl.compPct = pl.passAtt ? (100 * pl.passComp) / pl.passAtt : 0;
    pl.passYPA = pl.passAtt ? pl.passYards / pl.passAtt : 0;
    pl.successRate = pl.opportunities ? (100 * pl.successPlays) / pl.opportunities : 0;
    return pl;
  };

  return {
    home: Object.values(out.home).map(finish),
    away: Object.values(out.away).map(finish)
  };
}

/** Per-quarter splits for both teams. */
export function computeQuarterTrends(plays) {
  const quarters = [];
  plays.forEach((p) => {
    const q = num(p.quarter) || 1;
    if (!quarters.includes(q)) quarters.push(q);
  });
  quarters.sort((a, b) => a - b);
  const mk = () => quarters.map(() => ({ plays: 0, yards: 0, ypp: 0, points: 0, run: 0, pass: 0, success: 0, successRate: 0 }));
  const series = { home: mk(), away: mk() };
  plays.forEach((p) => {
    const qi = quarters.indexOf(num(p.quarter) || 1);
    if (qi < 0 || !series[p.team]) return;
    const s = series[p.team][qi];
    s.points += pointsFor(p);
    if (p.noPlay) return;
    if (p.playType === "run") s.run += 1;
    if (p.playType === "pass" || p.playType === "sack") s.pass += 1;
    if (isCountedPlay(p)) {
      s.plays += 1;
      s.yards += num(p.yards);
      if (isSuccessful(p)) s.success += 1;
    }
  });
  ["home", "away"].forEach((k) => series[k].forEach((s) => {
    s.ypp = s.plays ? s.yards / s.plays : 0;
    s.successRate = s.plays ? (100 * s.success) / s.plays : 0;
  }));
  return { quarters, series };
}

/**
 * Momentum: cumulative yards and a rolling yards-per-play average over each
 * team's own scrimmage plays, indexed by that team's play count.
 */
export function computeMomentum(plays, window = 8) {
  const out = { home: [], away: [] };
  const recent = { home: [], away: [] };
  const cum = { home: 0, away: 0 };
  plays.forEach((p) => {
    if (!isCountedPlay(p) || !out[p.team]) return;
    const y = num(p.yards);
    cum[p.team] += y;
    recent[p.team].push(y);
    if (recent[p.team].length > window) recent[p.team].shift();
    const arr = recent[p.team];
    const rollingYpp = arr.reduce((a, b) => a + b, 0) / arr.length;
    out[p.team].push({
      n: out[p.team].length + 1,
      seq: num(p.seq),
      quarter: num(p.quarter) || 1,
      yards: y,
      cumYards: cum[p.team],
      rollingYpp
    });
  });
  return out;
}

/** Efficiency by down (1st/2nd/3rd/4th) for both teams. */
export function computeDownSplits(plays) {
  const mk = () => [1, 2, 3, 4].map(() => ({ plays: 0, yards: 0, ypp: 0, success: 0, successRate: 0, run: 0, pass: 0 }));
  const series = { home: mk(), away: mk() };
  plays.forEach((p) => {
    if (!isCountedPlay(p) || !series[p.team]) return;
    const d = num(p.down);
    if (d < 1 || d > 4) return;
    const s = series[p.team][d - 1];
    s.plays += 1;
    s.yards += num(p.yards);
    if (isSuccessful(p)) s.success += 1;
    if (p.playType === "run") s.run += 1; else s.pass += 1;
  });
  ["home", "away"].forEach((k) => series[k].forEach((s) => {
    s.ypp = s.plays ? s.yards / s.plays : 0;
    s.successRate = s.plays ? (100 * s.success) / s.plays : 0;
  }));
  return series;
}

/** Yards per play by play type, for run/pass tendency analysis. */
export function computeTypeSplits(plays) {
  const mk = () => ({ run: { plays: 0, yards: 0, ypp: 0, success: 0, successRate: 0 }, pass: { plays: 0, yards: 0, ypp: 0, success: 0, successRate: 0 } });
  const out = { home: mk(), away: mk() };
  plays.forEach((p) => {
    if (!isCountedPlay(p) || !out[p.team]) return;
    const key = p.playType === "run" ? "run" : "pass";
    const s = out[p.team][key];
    s.plays += 1;
    s.yards += num(p.yards);
    if (isSuccessful(p)) s.success += 1;
  });
  ["home", "away"].forEach((k) => ["run", "pass"].forEach((key) => {
    const s = out[k][key];
    s.ypp = s.plays ? s.yards / s.plays : 0;
    s.successRate = s.plays ? (100 * s.success) / s.plays : 0;
  }));
  return out;
}

/** One-line English summary of each team's current trend. */
export function trendNotes(plays, teamNames) {
  const mom = computeMomentum(plays);
  const totals = computeTeamStats(plays);
  const notes = [];
  ["home", "away"].forEach((k) => {
    const m = mom[k];
    if (!m.length) return;
    const rolling = m[m.length - 1].rollingYpp;
    const avg = totals[k].yardsPerPlay;
    const delta = rolling - avg;
    const name = (teamNames && teamNames[k]) || (k === "home" ? "Home" : "Away");
    const dir = delta > 0.75 ? "heating up" : delta < -0.75 ? "cooling off" : "steady";
    notes.push({
      team: k,
      text: `${name}: ${dir} — last ${Math.min(8, m.length)} plays ${rolling.toFixed(1)} yds/play vs ${avg.toFixed(1)} game avg`,
      dir
    });
  });
  return notes;
}

export function formatPlay(p, rosters, teamNames) {
  const nameOf = (team, id) => {
    const list = (rosters && rosters[team]) || [];
    const pl = list.find((x) => x.id === id);
    if (!pl) return id ? "#?" : "";
    return `#${pl.num} ${pl.name}`.trim();
  };
  const team = (teamNames && teamNames[p.team]) || (p.team === "home" ? "Home" : "Away");
  const situation = p.down ? `${p.down}${["st", "nd", "rd", "th"][Math.min(num(p.down), 4) - 1]} & ${p.distance ?? "?"}` : "";
  const y = num(p.yards);
  let desc;
  switch (p.playType) {
    case "run":
      desc = `${nameOf(p.team, p.rusher)} run ${y >= 0 ? "+" : ""}${y}`;
      break;
    case "pass":
      desc = p.complete
        ? `${nameOf(p.team, p.passer)} pass complete to ${nameOf(p.team, p.receiver)} ${y >= 0 ? "+" : ""}${y}`
        : `${nameOf(p.team, p.passer)} pass incomplete${p.turnover === "int" ? " (INTERCEPTED)" : ""}`;
      break;
    case "sack":
      desc = `${nameOf(p.team, p.passer)} sacked ${y}`;
      break;
    case "punt": desc = "Punt"; break;
    case "kickoff": desc = "Kickoff"; break;
    case "fg": desc = `Field goal ${p.good ? "GOOD" : "missed"}`; break;
    case "xp": desc = `Extra point ${p.good ? "good" : "missed"}`; break;
    case "2pt": desc = `Two-point ${p.good ? "converted" : "failed"}`; break;
    case "penalty": desc = `Penalty on ${p.penaltyOn === "home" ? "home" : "away"} ${num(p.penaltyYards)} yds`; break;
    case "kneel": desc = "Kneel"; break;
    case "spike": desc = "Spike"; break;
    default: desc = p.playType || "Play";
  }
  const tags = [];
  if (p.touchdown) tags.push("TD");
  if (p.firstDown) tags.push("1st down");
  if (p.turnover === "fumble") tags.push("FUMBLE LOST");
  if (p.turnover === "downs") tags.push("turnover on downs");
  if (p.noPlay) tags.push("no play");
  return { team, situation, desc, tags };
}
