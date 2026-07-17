# iNaturalist Friends Feed (Web / PWA)

A browser version of the Android app: a feed of recent iNaturalist observations
from a list of friends. Installable as a Progressive Web App on any phone
(Android + iPhone) or desktop, distributed as a plain URL — no app store.

This is a **static site**. All data comes from the public iNaturalist v2 API,
which sends permissive CORS headers, so there is **no backend** to run or pay for.

**Live:** https://levi5384.github.io/inat-friends-feed-web/

This folder is a standalone git repo, published to GitHub Pages from the
[`levi5384/inat-friends-feed-web`](https://github.com/levi5384/inat-friends-feed-web)
repository (`main` branch, root). It sits alongside the Android app under the
shared `InatFriendsFeed-project/` parent folder, but the two are independent
repositories.

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

## Deploy / update

The site is already published to GitHub Pages (see **Live** above). To ship a
change:

```
git add -A
git commit -m "…"
git push            # Pages rebuilds automatically in a minute or two
```

When you change an app-shell file (`index.html`, `styles.css`, `app.js`), bump
`CACHE_VERSION` in `sw.js` so the service worker replaces the cached copy for
returning visitors. Otherwise they may keep seeing the old version until they
hard-refresh. The app uses relative URLs, so no base-path config is needed for
the project subpath.

To reproduce the Pages setup from scratch on another repo: enable
**Settings -> Pages**, source `main` branch / root folder.

## Known limitations

- **DOM volume.** The feed renders every observation in the window at once
  (~1,900 nodes for ~30 friends over 14 days). Unlike the Android app's lazy
  grid, there is no windowing/virtualization yet, so very large windows are
  memory-heavy. A future improvement would cap rendered items with a "load
  more" control or virtualize the grid.
- Friends and settings live in `localStorage`, per browser/device (not synced).

## Notes

- Editing the default friends list: change `DEFAULT_FRIENDS` in `app.js`.
- No auth; only public observations are shown, same as the app.
