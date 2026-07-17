# iNaturalist Friends Feed (Web / PWA)

A browser version of the Android app: a feed of recent iNaturalist observations
from a list of friends. Installable as a Progressive Web App on any phone
(Android + iPhone) or desktop, distributed as a plain URL — no app store.

This is a **static site**. All data comes from the public iNaturalist v2 API,
which sends permissive CORS headers, so there is **no backend** to run or pay for.

## Files

- `index.html` — app shell
- `styles.css` — styling (light + dark, responsive grid)
- `app.js` — all logic: API calls, windowed pagination, feed rendering,
  grouping, taxon filter, detail view, photo viewer, friends management
- `manifest.webmanifest` — PWA metadata (name, icons, theme)
- `sw.js` — service worker (offline app shell + photo caching)
- `icons/` — PWA icons

## Feature parity with the Android app

- iNat **v2 API** with field selection (small payloads)
- Windowed pagination (`created_d1`, `per_page=200`, stops on a short page)
- Grouped-by-observer and flat feed modes
- Layout density: large / 2-col / 3-col
- Taxon filter (iconic taxa) and time window (7/14/30/60/90 days)
- Observation detail view with identifications and comments
- Fullscreen photo viewer
- Add/remove friends (persisted in `localStorage`, defaults match the app)

## Run locally

Any static file server works. For example:

```
cd InatFriendsFeed-web
python -m http.server 8731
```

Then open http://localhost:8731/ . (A server is needed rather than opening the
file directly, because service workers require `http`/`https`.)

## Deploy to GitHub Pages

GitHub Pages serves static files for free over HTTPS (which PWAs require). Two
common setups:

1. **Project site from a subfolder** — if this folder lives inside a repo whose
   Pages is enabled, point Pages at the branch and set the folder, or move these
   files to `/docs` and select "main / docs" in the repo's Pages settings. The
   app uses relative URLs, so it works from any subpath.

2. **Dedicated repo** — create a repo containing just these files, push, then in
   the repo's **Settings -> Pages** choose the `main` branch, root folder.

The URL will look like `https://<user>.github.io/<repo>/`. Because the service
worker's `SHELL` and the manifest use relative paths, no base-path config is
needed.

## Notes

- Friends and settings live in `localStorage`, per browser/device (not synced).
- Editing the default friends list: change `DEFAULT_FRIENDS` in `app.js`.
- No auth; only public observations are shown, same as the app.
