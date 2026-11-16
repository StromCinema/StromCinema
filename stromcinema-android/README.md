# Strøm TV – Android TV front end

The TV app only does three things: connect to your Strøm server, show the cover shelf, and play with Android's own ExoPlayer. All settings (folders, TMDB key) stay on the server.

## 1. Server (Windows)
Copy `server/tv-api.cjs` next to your `plexus-server.cjs`. `server/plexus-server.cjs` is your file with ONE added line (before the static/SPA fallback) that loads it, so you can use it or add that line yourself:

    require('./tv-api.cjs')(app, { getConfig: () => config, saveConfig: () => saveConfig(config), baseDir: __dirname, axios });

Restart the server. New endpoints: `/api/tv/library`, `/api/tv/poster/:id`, `/api/tv/progress`, `/api/tv/settings`.
- Movies = files in library paths whose category contains "movie"/"film".
- Covers come from TMDB (key already in your server config), cached in `data/tv-posters`; watch progress in `data/tv-progress.json`.
- Shelf look is stored in `config.tv` (pose fan|shelf, fit fill|fit|stretch, round, speed, sort title|added, language). Change with `POST /api/tv/settings` (no UI for it yet).

## 2. TV app
    cd strom-tv
    npm install
    npm run build
    npx cap sync android
    npx cap open android      (Android Studio -> build/run on the TV)

Needs Android System WebView 88 or newer. versionCode 3 / versionName 2.0.0.

## Removed from the old app
Torrent code, Cast, browser/external-player plugins, Link Code flow.

## Added
Connection gate: saved server -> mDNS (_strom._tcp) -> scan of the TV's own network on port 5000 -> manual address with an on-screen keypad. Player now stops at end of film, shows a message on unplayable files, and reports progress to the server every 10 s (Resume / Start over on the shelf).

## Remote
Left/Right browse, OK plays, Down reaches Resume/Start over, Back opens Leave dialog (Cancel / Change server / Exit).
