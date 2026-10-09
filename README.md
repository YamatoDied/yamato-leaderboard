# Yamato Desktop leaderboard

The table of the Yamato Desktop spinner lives in `leaderboard.json` (read by the game, no key needed).
The game sends its results as issues titled `LB`; the Action in `.github/workflows/leaderboard.yml` checks them,
updates `leaderboard.json` and closes the issues. It runs on every new issue and every 15 minutes.

## Setup
1. Upload ALL files of this folder to the repository (including the hidden `.github` folder).
2. Settings -> Actions -> General -> Workflow permissions: **Read and write permissions**.
3. Settings -> General -> Features: **Issues** must be on.
4. Create a fine-grained token (Settings -> Developer settings): this repository only, permission **Issues: Read and write**, nothing else.
   Put it in `app/leaderboard-config.js` of the game (`token: '...'`).
5. Test: Actions tab -> `leaderboard` -> Run workflow.

## Moderation
`banned.json`: `hashes` = hashes of players (the `h` value in `leaderboard.json`) whose results are ignored, `words` = parts of nicknames that are not allowed.
To remove a player delete his line from `leaderboard.json`.
