# BGSN Football Stat Tracker

A plain static HTML/CSS/JavaScript live football stat tracker for BGSNvp. It records play-by-play for both teams in Firestore and provides a separate coach analytics dashboard (built in `dashboard.html`).

## URLs

- Live tracker: <https://bgsnvp.github.io/FootballStatTracker/>
- Coach dashboard: <https://bgsnvp.github.io/FootballStatTracker/dashboard.html>

The dashboard accepts the selected game in its query string:

`https://bgsnvp.github.io/FootballStatTracker/dashboard.html?game=<gameId>`

## GitHub Pages setup

1. Create the GitHub repository named `FootballStatTracker` under the `bgsnvp` account.
2. Push the contents of this directory to the repository's `main` branch.
3. In **Settings → Pages**, choose **Deploy from a branch**, select `main`, and choose `/ (root)`.
4. Wait for the Pages deployment, then open the tracker URL.
5. The app has no build step, npm dependency, or framework. Firebase modules load from the Google-hosted ES module CDN.

`js/firebase.js` currently points at the existing `bgsn-scoreboard` Firebase project. Keep that project configured in Firebase when deploying this site.

## Firestore data model

The tracker uses this layout:

```text
footballGames/{gameId}
footballGames/{gameId}/plays/{playId}
```

Each game document contains:

```js
{
  name: "Friday night football",
  date: "2025-09-12",
  gameId: "friday-night-football-abc12",
  homeName: "Home",
  awayName: "Away",
  rosters: {
    home: [{ id: "p_<timestamp>_<random>", num: "12", name: "Player", pos: "QB" }],
    away: []
  },
  quarter: 1,       // 1, 2, 3, 4, or 5 (OT)
  possession: "home",
  down: 1,
  distance: 10,
  yardLine: 25,     // yards from the offense's own goal line
  nextSeq: 1,
  updatedAt: "server timestamp"
}
```

Every play has a numeric, monotonically allocated `seq` and a server timestamp. The core play shape is defined in the header comment of `js/stats.js`:

```js
{
  seq: 1,
  team: "home",
  quarter: 1,
  playType: "run",       // run, pass, sack, kneel, spike, punt, kickoff, fg, xp, 2pt, penalty
  down: 1,
  distance: 10,
  yardLine: 25,
  yards: 4,
  rusher: "p_...",
  tacklers: ["p_..."],
  touchdown: false,
  firstDown: false,
  turnover: null,        // int, fumble, downs, or null
  ts: "server timestamp"
}
```

Fields such as passer, receiver, completion, kick result, penalty details, interception/forced-fumble credit, and `noPlay` are optional and are written when applicable. The tracker also stores `stateBefore`/`stateAfter` on new plays so Undo can restore the game state after a live entry.

## Firestore rules

The existing Firebase project's rules may not cover the new `footballGames` collection. This is a required setup step before live writes will work. In Firebase Console → Firestore Database → Rules, paste and publish:

```text
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /footballGames/{gameId} {
      allow read, write: if true;

      match /{subcollection=**} {
        allow read, write: if true;
      }
    }
  }
}
```

These open rules are convenient for an internal scoreboard prototype but are not appropriate for a public production application. Add authentication and restrict access before using the tracker with sensitive data.

If rules are not published, the UI reports Firestore errors through the red connection badge and visible error toasts; it does not silently treat a rejected write as successful.
