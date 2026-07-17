"use strict";

/* ---------------------------------------------------------------------------
 * iNaturalist Friends Feed — web port of the Android app.
 * Mirrors the app's behavior: v2 API with field selection, windowed pagination,
 * grouped-by-observer/flat modes, taxon filter, time window, layout density,
 * a detail view and a fullscreen photo viewer. Friends + settings persist in
 * localStorage. No backend: the iNat v2 API sends permissive CORS headers, so
 * the browser calls it directly.
 * ------------------------------------------------------------------------- */

const API_BASE = "https://api.inaturalist.org/";
const PAGE_SIZE = 200;      // iNat: page * per_page must not exceed 10,000
const MAX_PAGES = 50;
const USER_AGENT_NOTE = "InatFriendsFeed-web";

const WINDOW_DAY_OPTIONS = [7, 14, 30, 60, 90];
const DEFAULT_WINDOW_DAYS = 14;

// iNat v2 field-selection spec. v2 returns almost nothing unless you name the
// fields you want, which shrinks a 200-item page from ~1 MB to tens of KB.
const LIST_FIELDS =
  "(id:!t,uuid:!t,observed_on_string:!t,observed_on:!t,time_observed_at:!t," +
  "place_guess:!t,location:!t,description:!t,uri:!t,quality_grade:!t," +
  "identifications_count:!t,comments_count:!t," +
  "user:(id:!t,login:!t,name:!t,icon_url:!t)," +
  "taxon:(id:!t,name:!t,preferred_common_name:!t,rank:!t,iconic_taxon_name:!t)," +
  "photos:(id:!t,url:!t)," +
  "identifications:(id:!t,body:!t,category:!t,created_at:!t,current:!t," +
  "user:(id:!t,login:!t,icon_url:!t)," +
  "taxon:(id:!t,name:!t,preferred_common_name:!t,rank:!t,iconic_taxon_name:!t))," +
  "comments:(id:!t,body:!t,created_at:!t,user:(id:!t,login:!t,icon_url:!t)))";

// iNat iconic taxon groupings — the quick filters from the iNat website.
const ICONIC_TAXA = [
  { label: "Plants", api: "Plantae" },
  { label: "Fungi", api: "Fungi" },
  { label: "Insects", api: "Insecta" },
  { label: "Arachnids", api: "Arachnida" },
  { label: "Mollusks", api: "Mollusca" },
  { label: "Amphibians", api: "Amphibia" },
  { label: "Reptiles", api: "Reptilia" },
  { label: "Birds", api: "Aves" },
  { label: "Mammals", api: "Mammalia" },
  { label: "Ray-finned Fishes", api: "Actinopterygii" },
  { label: "Other Animals", api: "Animalia" },
  { label: "Protozoans", api: "Protozoa" },
  { label: "Chromista", api: "Chromista" },
  { label: "Unknown", api: "" },
];

/* Each visitor keeps their own friends list in this browser's localStorage —
 * it is private to them and persists across visits. New visitors start with an
 * empty list and are prompted to add their own iNaturalist logins. */

/* ------------------------------- persistence ----------------------------- */

const Store = {
  friends() {
    try {
      const raw = localStorage.getItem("friends");
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  },
  setFriends(list) {
    localStorage.setItem("friends", JSON.stringify(list));
  },
  windowDays() {
    const v = parseInt(localStorage.getItem("windowDays"), 10);
    return WINDOW_DAY_OPTIONS.includes(v) ? v : DEFAULT_WINDOW_DAYS;
  },
  setWindowDays(d) { localStorage.setItem("windowDays", String(d)); },
  layout() { return localStorage.getItem("layout") || "grid3"; },
  setLayout(l) { localStorage.setItem("layout", l); },
  mode() { return localStorage.getItem("mode") || "grouped"; },
  setMode(m) { localStorage.setItem("mode", m); },
};

/* --------------------------------- state --------------------------------- */

const state = {
  observations: [],
  loading: true,
  loadingMore: false,
  endReached: false,
  error: null,
  fetchedAt: Date.now(),
  taxonFilter: new Set(),
  collapsed: new Set(),
  loadToken: 0,
};

/* --------------------------------- api ----------------------------------- */

function photoSize(url, size) {
  return url ? url.replace("square.", size + ".") : null;
}

/** iNat v2 returns location as a "lat,lng" string; parse it or return null. */
function parseLatLng(location) {
  if (!location) return null;
  const parts = String(location).split(",");
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

async function fetchPage(userLogin, sinceDate, page) {
  const params = new URLSearchParams({
    user_login: userLogin,
    created_d1: sinceDate,
    per_page: String(PAGE_SIZE),
    page: String(page),
    order: "desc",
    order_by: "created_at",
    fields: LIST_FIELDS,
  });
  const res = await fetch(`${API_BASE}v2/observations?${params.toString()}`, {
    headers: { Accept: "application/json", "X-Via": USER_AGENT_NOTE },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadFeed() {
  const token = ++state.loadToken;
  state.loading = true;
  state.error = null;
  state.endReached = false;
  render();

  const friends = Store.friends();
  if (friends.length === 0) {
    state.observations = [];
    state.loading = false;
    state.endReached = true;
    render();
    return;
  }

  const userLogin = friends.join(",");
  const since = new Date(Date.now() - Store.windowDays() * 86400000)
    .toISOString().slice(0, 10);
  const fetchedAt = Date.now();
  const accumulated = [];
  const seen = new Set();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const resp = await fetchPage(userLogin, since, page);
      if (token !== state.loadToken) return; // superseded by a newer load
      const results = resp.results || [];
      for (const obs of results) {
        if (!seen.has(obs.id)) { seen.add(obs.id); accumulated.push(obs); }
      }
      const endReached = results.length < PAGE_SIZE;
      state.observations = accumulated.slice();
      state.loading = false;
      state.loadingMore = !endReached;
      state.endReached = endReached;
      state.fetchedAt = fetchedAt;
      render();
      if (endReached) break;
    }
  } catch (err) {
    if (token !== state.loadToken) return;
    if (accumulated.length === 0) {
      state.error = err.message || "Unknown error";
      state.loading = false;
    } else {
      state.observations = accumulated;
      state.loading = false;
      state.loadingMore = false;
      state.endReached = true;
    }
    render();
  }
}

/* ------------------------------- rendering ------------------------------- */

const feedEl = document.getElementById("feed");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function relativeTime(ms) {
  const delta = Math.max(0, Date.now() - ms);
  const min = Math.floor(delta / 60000);
  const hr = Math.floor(delta / 3600000);
  const day = Math.floor(delta / 86400000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (hr < 24) return `${hr} hr ago`;
  if (day === 1) return "yesterday";
  return `${day} days ago`;
}

function filteredObservations() {
  if (state.taxonFilter.size === 0) return state.observations;
  return state.observations.filter((obs) => {
    const iconic = obs.taxon && obs.taxon.iconic_taxon_name;
    for (const api of state.taxonFilter) {
      if (api === "") { if (!iconic) return true; }
      else if (iconic === api) return true;
    }
    return false;
  });
}

function currentLayout() { return Store.layout(); }

function photoForLayout(layout) {
  if (layout === "grid2") return "medium";
  if (layout === "grid3") return "small";
  return "large";
}

/**
 * A swipeable inline photo pager for a feed card, mirroring the Android app's
 * HorizontalPager: horizontal swipe (touch or trackpad) moves between an
 * observation's photos, page dots show the position, and a tap opens the
 * fullscreen viewer at the current photo. Images are lazily built as the user
 * pages, so a card with many photos does not fetch them all up front.
 */
function buildPhotoWrap(obs, size, withAvatar) {
  const wrap = el("div", "photo-wrap");
  const photos = obs.photos || [];
  const alt = (obs.taxon && (obs.taxon.preferred_common_name || obs.taxon.name)) || "observation";

  const track = el("div", "photo-track");
  wrap.appendChild(track);

  const built = new Set();
  function buildSlide(i) {
    if (built.has(i)) return;
    built.add(i);
    const slide = track.children[i];
    const img = el("img");
    img.loading = "lazy";
    img.src = photos[i] ? photoSize(photos[i].url, size) : "";
    img.alt = alt;
    slide.appendChild(img);
  }

  const count = Math.max(photos.length, 1);
  for (let i = 0; i < count; i++) track.appendChild(el("div", "photo-slide"));
  buildSlide(0);

  let index = 0;
  const pill = photos.length > 1 ? el("div", "count-pill", `1/${photos.length}`) : null;
  let dots = null;
  if (photos.length > 1) {
    dots = el("div", "pager-dots");
    for (let i = 0; i < photos.length; i++) dots.appendChild(el("span", i === 0 ? "on" : null));
  }

  function goTo(i) {
    index = Math.max(0, Math.min(photos.length - 1, i));
    buildSlide(index);
    track.style.transform = `translateX(-${index * 100}%)`;
    if (pill) pill.textContent = `${index + 1}/${photos.length}`;
    if (dots) {
      for (let d = 0; d < dots.children.length; d++)
        dots.children[d].className = d === index ? "on" : "";
    }
  }

  if (photos.length > 1) attachSwipe(wrap, () => index, goTo, photos.length);

  if (pill) wrap.appendChild(pill);
  if (dots) wrap.appendChild(dots);
  if (withAvatar && obs.user && obs.user.icon_url) {
    const av = el("img", "avatar-badge");
    av.src = obs.user.icon_url;
    av.alt = obs.user.login || "";
    wrap.appendChild(av);
  }

  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    openViewer(photos, index);
  });
  return wrap;
}

/**
 * Wire pointer-based horizontal swipe onto a container that holds its own direct
 * `.photo-track`. Dragging past a threshold changes page; taps (little movement)
 * fall through to the container's click handler.
 *
 * Nested pagers (a photo pager inside the observation-detail pager) must not
 * fight each other. Two rules keep them separate:
 *   1. Each handler drives only its *own* track — `:scope > .photo-track` — not
 *      a descendant pager's track.
 *   2. Once a gesture is locked as horizontal, the innermost handler that claims
 *      it calls stopPropagation on the move/up events, so an ancestor handler
 *      never starts dragging from the same gesture. The photo pager sits inside
 *      the observation pager, so it wins for swipes that begin on a photo, while
 *      swipes that begin on the rest of the page reach the observation pager.
 */
function attachSwipe(container, getIndex, goTo, count) {
  const track = container.querySelector(":scope > .photo-track");
  if (!track) return;
  // dir: null = undecided, "h" = horizontal (ours), "v" = vertical (let scroll)
  let startX = 0, startY = 0, active = false, dir = null, moved = false, width = 1;

  container.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A pointerdown bubbles from the innermost element outward. The first
    // (innermost) pager to see it claims it by tagging the event; ancestor
    // pagers then ignore this gesture entirely, so a swipe that starts on a
    // photo never also drives the observation pager, and vice versa.
    if (e._swipeClaimed) return;
    e._swipeClaimed = true;

    active = true;
    dir = null;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    width = container.clientWidth || 1;
  });

  container.addEventListener("pointermove", (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // Lock the gesture direction once it moves past a small deadzone.
    if (dir === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      dir = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
      if (dir === "h") {
        track.style.transition = "none";
        // Keep receiving moves even if the finger leaves the element.
        try { container.setPointerCapture(e.pointerId); } catch (_) {}
      } else {
        // Vertical gesture: we don't own it. Release so the page scrolls.
        active = false;
        return;
      }
    }

    if (dir !== "h") return;
    if (e.cancelable) e.preventDefault();
    moved = true;
    const base = -getIndex() * 100;
    track.style.transform = `translateX(calc(${base}% + ${dx}px))`;
  });

  function end(e) {
    if (!active) return;
    active = false;
    if (dir !== "h") { dir = null; return; }
    track.style.transition = "";
    const dx = (e.clientX || startX) - startX;
    // Advance on a fast-enough flick or a drag past a threshold. The threshold
    // is a fraction of width but capped so wide desktop windows don't require
    // an enormous drag.
    const threshold = Math.min(width * 0.25, 70);
    if (Math.abs(dx) > threshold) {
      goTo(getIndex() + (dx < 0 ? 1 : -1));
    } else {
      goTo(getIndex());
    }
    dir = null;
  }
  container.addEventListener("pointerup", end);
  container.addEventListener("pointercancel", end);
  // Swallow the click that follows a real drag so it doesn't open the viewer
  // or trigger the card/observation click.
  container.addEventListener("click", (e) => {
    if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
  }, true);
}

function taxonNames(obs) {
  const common = obs.taxon && obs.taxon.preferred_common_name;
  const sci = obs.taxon && obs.taxon.name;
  return { common: common || "", sci: sci || "", hasCommon: !!(common && common.trim()) };
}

function buildCard(obs, layout) {
  const card = el("div", "card " + (layout === "large" ? "large" : "tile"));
  card.addEventListener("click", () => openDetail(obs));

  if (layout === "large") {
    // user header
    const head = el("div", "user-head");
    const av = el("img");
    av.src = (obs.user && obs.user.icon_url) || "";
    av.alt = "";
    head.appendChild(av);
    const col = el("div");
    col.appendChild(el("div", "login", (obs.user && obs.user.login) || "unknown"));
    const subtitle = obs.observed_on_string || obs.observed_on || obs.time_observed_at;
    if (subtitle) col.appendChild(el("div", "date", subtitle));
    head.appendChild(col);
    card.appendChild(head);

    card.appendChild(buildPhotoWrap(obs, "large", false));

    const footer = el("div", "footer");
    const { common, sci, hasCommon } = taxonNames(obs);
    footer.appendChild(el("p", "taxon-common", common || sci || "Unknown"));
    if (sci && (!hasCommon || common !== sci)) footer.appendChild(el("p", "taxon-sci", sci));
    if (obs.place_guess) {
      const place = el("div", "place");
      place.appendChild(el("span", null, "\u{1f4cd}"));
      place.appendChild(el("span", null, obs.place_guess));
      footer.appendChild(place);
    }
    card.appendChild(footer);
  } else {
    card.appendChild(buildPhotoWrap(obs, photoForLayout(layout), true));
    const footer = el("div", "footer");
    const { common, sci, hasCommon } = taxonNames(obs);
    footer.appendChild(el("p", "taxon-common", common || sci || "Unknown"));
    if (hasCommon && sci && common !== sci) footer.appendChild(el("p", "taxon-sci", sci));
    footer.appendChild(el("p", "tile-login", (obs.user && obs.user.login) || ""));
    card.appendChild(footer);
  }
  return card;
}

function buildObserverHeader(login, obsList) {
  const collapsed = state.collapsed.has(login);
  const header = el("div", "observer-header span-all");
  const av = el("img");
  av.src = (obsList[0].user && obsList[0].user.icon_url) || "";
  av.alt = "";
  header.appendChild(av);
  header.appendChild(el("div", "name", login));
  header.appendChild(el("div", "count", String(obsList.length)));
  header.appendChild(el("div", "chev", collapsed ? "▼" : "▲"));
  header.addEventListener("click", () => {
    if (state.collapsed.has(login)) state.collapsed.delete(login);
    else state.collapsed.add(login);
    render();
  });
  return header;
}

function render() {
  const layout = currentLayout();
  feedEl.className = "feed layout-" + layout;
  feedEl.innerHTML = "";

  if (state.loading) {
    feedEl.appendChild(el("div", "spinner"));
    updateChrome();
    return;
  }
  if (state.error) {
    feedEl.appendChild(el("div", "centered", `Couldn't load feed: ${state.error}`));
    updateChrome();
    return;
  }

  // fetched-at banner
  const banner = el("div", "fetched-banner span-all");
  banner.appendChild(el("span", null, "\u{1f552}"));
  banner.appendChild(el("span", null, "Updated " + relativeTime(state.fetchedAt)));
  feedEl.appendChild(banner);

  // No friends added yet — guide the visitor to add their own.
  if (Store.friends().length === 0) {
    const empty = el("div", "centered");
    empty.appendChild(el("p", null, "No friends added yet."));
    empty.appendChild(el("p", null,
      "Add the iNaturalist logins of people you want to follow to build your feed. Your list is saved privately in this browser."));
    const btn = el("button", "primary-btn", "Add friends");
    btn.addEventListener("click", openFriendsDialog);
    empty.appendChild(btn);
    feedEl.appendChild(empty);
    updateChrome();
    return;
  }

  const filtered = filteredObservations();
  if (filtered.length === 0) {
    const msg = state.observations.length === 0
      ? "No recent observations from your friends."
      : "No observations match the current filter.";
    feedEl.appendChild(el("div", "centered", msg));
    updateChrome();
    return;
  }

  if (Store.mode() === "grouped") {
    const groups = new Map();
    for (const obs of filtered) {
      const login = (obs.user && obs.user.login) || "unknown";
      if (!groups.has(login)) groups.set(login, []);
      groups.get(login).push(obs);
    }
    for (const [login, list] of groups) {
      feedEl.appendChild(buildObserverHeader(login, list));
      if (!state.collapsed.has(login)) {
        for (const obs of list) feedEl.appendChild(buildCard(obs, layout));
      }
    }
  } else {
    for (const obs of filtered) feedEl.appendChild(buildCard(obs, layout));
  }

  if (state.loadingMore) {
    feedEl.appendChild(el("div", "spinner small"));
  } else if (state.endReached) {
    feedEl.appendChild(el("div", "end-note", "End of feed"));
  }
  updateChrome();
}

/* --------------------------- top-bar chrome ------------------------------ */

function updateChrome() {
  // taxon badge
  const badge = document.getElementById("taxon-badge");
  if (state.taxonFilter.size > 0) {
    badge.textContent = String(state.taxonFilter.size);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
  // mode icon
  document.getElementById("btn-mode").innerHTML =
    Store.mode() === "grouped" ? "\u{1f464}" : "≡";
  // layout icon
  const layout = Store.layout();
  document.getElementById("btn-layout").textContent =
    layout === "large" ? "▬" : layout === "grid2" ? "▦" : "▦";
}

/* -------------------------------- menus ---------------------------------- */

function closeAllMenus() {
  document.getElementById("menu-window").hidden = true;
  document.getElementById("menu-taxon").hidden = true;
}

function windowLabel(days) {
  switch (days) {
    case 7: return "Last 7 days";
    case 14: return "Last 2 weeks";
    case 30: return "Last 30 days";
    case 60: return "Last 60 days";
    case 90: return "Last 90 days";
    default: return `Last ${days} days`;
  }
}

function buildWindowMenu() {
  const menu = document.getElementById("menu-window");
  menu.innerHTML = "";
  const hdr = el("div", "menu-item header", "Show observations from");
  menu.appendChild(hdr);
  menu.appendChild(el("div", "menu-sep"));
  const current = Store.windowDays();
  for (const days of WINDOW_DAY_OPTIONS) {
    const item = el("div", "menu-item" + (days === current ? " selected" : ""), windowLabel(days));
    item.addEventListener("click", () => {
      closeAllMenus();
      if (days !== Store.windowDays()) { Store.setWindowDays(days); loadFeed(); }
    });
    menu.appendChild(item);
  }
}

function buildTaxonMenu() {
  const menu = document.getElementById("menu-taxon");
  menu.innerHTML = "";
  const clear = el("div", "menu-item",
    state.taxonFilter.size === 0 ? "All taxa" : "Clear filter");
  clear.style.fontWeight = "600";
  clear.addEventListener("click", () => {
    state.taxonFilter.clear();
    closeAllMenus();
    render();
  });
  menu.appendChild(clear);
  menu.appendChild(el("div", "menu-sep"));
  for (const t of ICONIC_TAXA) {
    const item = el("div", "menu-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.taxonFilter.has(t.api);
    item.appendChild(cb);
    item.appendChild(el("span", null, t.label));
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.taxonFilter.has(t.api)) state.taxonFilter.delete(t.api);
      else state.taxonFilter.add(t.api);
      buildTaxonMenu();
      render();
      document.getElementById("menu-taxon").hidden = false;
    });
    menu.appendChild(item);
  }
}

/* ----------------------------- friends dialog ---------------------------- */

function renderFriendsList() {
  const ul = document.getElementById("friends-list");
  ul.innerHTML = "";
  const friends = Store.friends();
  if (friends.length === 0) {
    ul.appendChild(el("li", "empty", "No friends yet. Add one above."));
    return;
  }
  for (const login of friends) {
    const li = el("li");
    li.appendChild(el("span", null, login));
    const rm = el("button", "remove", "✕");
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      Store.setFriends(Store.friends().filter((f) => f !== login));
      renderFriendsList();
      loadFeed();
    });
    li.appendChild(rm);
    ul.appendChild(li);
  }
}

function openFriendsDialog() {
  renderFriendsList();
  document.getElementById("friends-dialog").hidden = false;
}

/* ------------------------------ detail view ------------------------------ */

function sameObserverList(obs) {
  const login = obs.user && obs.user.login;
  if (!login) return [obs];
  return state.observations.filter((o) => o.user && o.user.login === login);
}

/** Build the scrollable body for a single observation in the detail view. */
function buildDetailBody(o) {
  const body = el("div", "detail-body");

  // main photo (swipeable pager, tap to open fullscreen)
  const photos = o.photos || [];
  if (photos.length > 0) {
    const pw = el("div", "detail-photo");
    pw.appendChild(buildDetailPhotoPager(photos));
    body.appendChild(pw);
  }

  // taxon + place
  const sec = el("div", "detail-section");
  const { common, sci, hasCommon } = taxonNames(o);
  sec.appendChild(el("p", "taxon-common", common || sci || "Unknown"));
  if (sci && (!hasCommon || common !== sci)) sec.appendChild(el("p", "taxon-sci", sci));
  const when = o.observed_on_string || o.observed_on || o.time_observed_at;
  if (when) sec.appendChild(el("div", "meta-line", "Observed " + when));
  if (o.place_guess) sec.appendChild(el("div", "meta-line", "\u{1f4cd} " + o.place_guess));
  if (o.description && o.description.trim()) {
    sec.appendChild(el("p", null, o.description));
  }
  body.appendChild(sec);

  // map
  const ll = parseLatLng(o.location);
  if (ll) body.appendChild(buildMapBlock(ll.lat, ll.lng));

  // identifications
  const ids = (o.identifications || []).filter((i) => i.current !== false);
  if (ids.length > 0) {
    const idSec = el("div", "detail-section");
    idSec.appendChild(el("h3", null, `Identifications (${ids.length})`));
    for (const id of ids) {
      const row = el("div", "id-row");
      const av = el("img");
      av.src = (id.user && id.user.icon_url) || "";
      row.appendChild(av);
      const col = el("div");
      col.appendChild(el("div", "who", (id.user && id.user.login) || "someone"));
      const what = el("div", "what");
      const tn = id.taxon && (id.taxon.preferred_common_name || id.taxon.name);
      what.textContent = tn || "";
      col.appendChild(what);
      if (id.body && id.body.trim()) col.appendChild(el("div", "meta-line", id.body));
      row.appendChild(col);
      idSec.appendChild(row);
    }
    body.appendChild(idSec);
  }

  // comments
  const comments = o.comments || [];
  if (comments.length > 0) {
    const cSec = el("div", "detail-section");
    cSec.appendChild(el("h3", null, `Comments (${comments.length})`));
    for (const c of comments) {
      const row = el("div", "comment-row");
      const av = el("img");
      av.src = (c.user && c.user.icon_url) || "";
      row.appendChild(av);
      const col = el("div");
      col.appendChild(el("div", "who", (c.user && c.user.login) || "someone"));
      col.appendChild(el("div", "body", c.body || ""));
      row.appendChild(col);
      cSec.appendChild(row);
    }
    body.appendChild(cSec);
  }

  return body;
}

/** Swipeable large-photo pager for the detail view; tap opens the viewer. */
function buildDetailPhotoPager(photos) {
  const wrap = el("div", "detail-photo-pager");
  const track = el("div", "photo-track");
  const built = new Set();
  function buildSlide(i) {
    if (built.has(i)) return;
    built.add(i);
    const img = el("img");
    img.src = photoSize(photos[i].url, "large");
    img.alt = "";
    track.children[i].appendChild(img);
  }
  for (let i = 0; i < photos.length; i++) track.appendChild(el("div", "photo-slide"));
  buildSlide(0);
  wrap.appendChild(track);

  let index = 0;
  let dots = null;
  if (photos.length > 1) {
    dots = el("div", "pager-dots");
    for (let i = 0; i < photos.length; i++) dots.appendChild(el("span", i === 0 ? "on" : null));
    wrap.appendChild(dots);
  }
  function goTo(i) {
    index = Math.max(0, Math.min(photos.length - 1, i));
    buildSlide(index);
    track.style.transform = `translateX(-${index * 100}%)`;
    if (dots) for (let d = 0; d < dots.children.length; d++)
      dots.children[d].className = d === index ? "on" : "";
  }
  if (photos.length > 1) attachSwipe(wrap, () => index, goTo, photos.length);
  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    openViewer(photos, index);
  });
  return wrap;
}

/* --------------------------------- map ----------------------------------- */

// Web Mercator projection helpers (world coordinates in tile units), matching
// the Android InteractiveMap.
function lonToWorldX(lon, zoom) { return (lon + 180) / 360 * (1 << zoom); }
function latToWorldY(lat, zoom) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * (1 << zoom);
}

const MAP_TILE = 256;
const MAP_MIN_ZOOM = 3;
const MAP_MAX_ZOOM = 18;

/**
 * A pannable / zoomable OpenStreetMap raster-tile map, ported from the Android
 * app's InteractiveMap. Drag to pan, scroll / pinch / +- buttons to zoom; a red
 * marker sits on the observation and stays put across zoom changes. Only the
 * tiles intersecting the viewport are in the DOM, rebuilt on pan/zoom.
 */
function buildMapBlock(lat, lng) {
  const block = el("div", "detail-section map-block");

  const head = el("div", "map-head");
  head.appendChild(el("h3", null, "Location"));
  const openLink = document.createElement("a");
  openLink.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`;
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.textContent = "Open in Maps ↗";
  head.appendChild(openLink);
  block.appendChild(head);

  const map = el("div", "map");
  const tileLayer = el("div", "map-tiles");
  const marker = el("div", "map-marker");
  map.appendChild(tileLayer);
  map.appendChild(marker);

  const zoomCtl = el("div", "map-zoom");
  const zoomIn = el("button", null, "+");
  const zoomOut = el("button", null, "−");
  zoomCtl.appendChild(zoomIn);
  zoomCtl.appendChild(zoomOut);
  map.appendChild(zoomCtl);

  const attribution = el("div", "map-attr", "© OpenStreetMap");
  map.appendChild(attribution);

  block.appendChild(map);
  block.appendChild(el("div", "meta-line",
    `${lat.toFixed(4)}, ${lng.toFixed(4)}  ·  drag to pan, scroll to zoom`));

  // Map state in world pixels at the current integer zoom.
  let zoom = 12;
  let centerX = 0, centerY = 0;
  let initialized = false;

  function worldSize(z) { return MAP_TILE * Math.pow(2, z); }
  function recenterOnMarker() {
    centerX = lonToWorldX(lng, zoom) * MAP_TILE;
    centerY = latToWorldY(lat, zoom) * MAP_TILE;
  }
  function changeZoom(newZoom) {
    const clamped = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, newZoom));
    if (clamped === zoom) return;
    const factor = Math.pow(2, clamped - zoom);
    centerX *= factor;
    centerY *= factor;
    zoom = clamped;
    drawMap();
  }

  function drawMap() {
    const w = map.clientWidth, h = map.clientHeight;
    if (w === 0 || h === 0) return;
    if (!initialized) { recenterOnMarker(); initialized = true; }

    const tilesPerAxis = 1 << zoom;
    const originX = centerX - w / 2;
    const originY = centerY - h / 2;
    const firstX = Math.floor(originX / MAP_TILE);
    const firstY = Math.floor(originY / MAP_TILE);
    const lastX = Math.floor((originX + w) / MAP_TILE);
    const lastY = Math.floor((originY + h) / MAP_TILE);

    tileLayer.innerHTML = "";
    for (let ty = firstY; ty <= lastY; ty++) {
      if (ty < 0 || ty >= tilesPerAxis) continue;
      for (let tx = firstX; tx <= lastX; tx++) {
        const wrappedX = ((tx % tilesPerAxis) + tilesPerAxis) % tilesPerAxis;
        const sub = "abc"[((wrappedX + ty) % 3 + 3) % 3];
        const img = el("img", "map-tile");
        img.src = `https://${sub}.tile.openstreetmap.org/${zoom}/${wrappedX}/${ty}.png`;
        img.draggable = false;
        img.style.left = (tx * MAP_TILE - originX) + "px";
        img.style.top = (ty * MAP_TILE - originY) + "px";
        tileLayer.appendChild(img);
      }
    }

    // Marker position relative to the viewport.
    const mWorldX = lonToWorldX(lng, zoom) * MAP_TILE;
    const mWorldY = latToWorldY(lat, zoom) * MAP_TILE;
    marker.style.left = (mWorldX - originX) + "px";
    marker.style.top = (mWorldY - originY) + "px";
  }

  // Drag to pan.
  let dragging = false, lastX = 0, lastY = 0;
  map.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".map-zoom")) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    map.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  map.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    centerX -= e.clientX - lastX;
    centerY -= e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const ws = worldSize(zoom);
    centerY = Math.max(0, Math.min(ws, centerY));
    if (centerX < 0) centerX += ws;
    if (centerX > ws) centerX -= ws;
    drawMap();
  });
  function stopDrag() { dragging = false; }
  map.addEventListener("pointerup", stopDrag);
  map.addEventListener("pointercancel", stopDrag);

  map.addEventListener("wheel", (e) => {
    e.preventDefault();
    changeZoom(zoom + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  zoomIn.addEventListener("click", (e) => { e.stopPropagation(); changeZoom(zoom + 1); });
  zoomOut.addEventListener("click", (e) => { e.stopPropagation(); changeZoom(zoom - 1); });

  // Draw once the element has a measured size. It is added to the DOM by the
  // caller; a ResizeObserver covers both the initial layout and later resizes.
  const ro = new ResizeObserver(() => drawMap());
  ro.observe(map);

  return block;
}

function openDetail(obs) {
  const list = sameObserverList(obs);
  let index = list.findIndex((o) => o.id === obs.id);
  if (index < 0) index = 0;
  const overlay = document.getElementById("detail-overlay");
  overlay.innerHTML = "";

  const panel = el("div", "detail");

  // top bar (updated as you page between observations)
  const top = el("div", "detail-top");
  const back = el("button", "icon-btn", "←");
  back.addEventListener("click", closeDetail);
  top.appendChild(back);
  const loginEl = el("div", "login");
  top.appendChild(loginEl);
  const link = document.createElement("a");
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "View on iNat ↗";
  top.appendChild(link);
  panel.appendChild(top);

  // Prev/Next row (desktop affordance; swipe works too)
  let pos = null, prev = null, next = null;
  if (list.length > 1) {
    const nav = el("div", "detail-nav");
    prev = el("button", null, "← Prev");
    prev.addEventListener("click", () => goTo(index - 1));
    pos = el("span", null, `${index + 1} of ${list.length}`);
    next = el("button", null, "Next →");
    next.addEventListener("click", () => goTo(index + 1));
    nav.appendChild(prev); nav.appendChild(pos); nav.appendChild(next);
    panel.appendChild(nav);
  }

  // Swipeable stage: one body page per observation, built lazily.
  const stage = el("div", "detail-stage");
  const track = el("div", "photo-track");
  const builtPages = new Set();
  function buildPage(i) {
    if (builtPages.has(i)) return;
    builtPages.add(i);
    track.children[i].appendChild(buildDetailBody(list[i]));
  }
  for (let i = 0; i < list.length; i++) {
    const page = el("div", "detail-page photo-slide");
    track.appendChild(page);
  }
  stage.appendChild(track);
  panel.appendChild(stage);

  function updateChromeForIndex() {
    const o = list[index];
    loginEl.textContent = (o.user && o.user.login) || "unknown";
    link.href = o.uri || `https://www.inaturalist.org/observations/${o.id}`;
    if (pos) pos.textContent = `${index + 1} of ${list.length}`;
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === list.length - 1;
  }

  function goTo(i) {
    index = Math.max(0, Math.min(list.length - 1, i));
    buildPage(index);
    if (index > 0) buildPage(index - 1);
    if (index < list.length - 1) buildPage(index + 1);
    track.style.transform = `translateX(-${index * 100}%)`;
    updateChromeForIndex();
  }

  buildPage(index);
  track.style.transition = "none";
  track.style.transform = `translateX(-${index * 100}%)`;
  requestAnimationFrame(() => { track.style.transition = ""; });
  updateChromeForIndex();
  if (list.length > 1) attachSwipe(stage, () => index, goTo, list.length);

  overlay.appendChild(panel);
  overlay.hidden = false;
}

function closeDetail() {
  document.getElementById("detail-overlay").hidden = true;
  document.getElementById("detail-overlay").innerHTML = "";
}

/* -------------------------- fullscreen viewer ---------------------------- */

let viewerNav = null; // keyboard arrow handler for the currently-open viewer

function openViewer(photos, startIndex) {
  if (!photos || photos.length === 0) return;
  let index = Math.max(0, Math.min(photos.length - 1, startIndex || 0));
  const overlay = document.getElementById("viewer-overlay");
  overlay.innerHTML = "";

  const close = el("button", "viewer-close", "✕");
  close.addEventListener("click", closeViewer);
  overlay.appendChild(close);

  // Swipeable track of full-size images (built lazily as pages are visited).
  const stage = el("div", "viewer-stage");
  const track = el("div", "photo-track");
  const built = new Set();
  function buildSlide(i) {
    if (built.has(i)) return;
    built.add(i);
    const img = el("img");
    img.src = photoSize(photos[i].url, "large");
    img.alt = "";
    track.children[i].appendChild(img);
  }
  for (let i = 0; i < photos.length; i++) track.appendChild(el("div", "photo-slide"));
  stage.appendChild(track);
  overlay.appendChild(stage);

  const counter = photos.length > 1
    ? el("div", "viewer-counter", `${index + 1} / ${photos.length}`)
    : null;

  function goTo(i) {
    index = Math.max(0, Math.min(photos.length - 1, i));
    buildSlide(index);
    if (index > 0) buildSlide(index - 1);
    if (index < photos.length - 1) buildSlide(index + 1);
    track.style.transform = `translateX(-${index * 100}%)`;
    if (counter) counter.textContent = `${index + 1} / ${photos.length}`;
  }

  buildSlide(index);
  track.style.transition = "none";
  track.style.transform = `translateX(-${index * 100}%)`;
  // Restore transitions after the initial (non-animated) positioning.
  requestAnimationFrame(() => { track.style.transition = ""; });
  goTo(index);

  if (photos.length > 1) {
    attachSwipe(stage, () => index, goTo, photos.length);

    const prev = el("button", "viewer-arrow prev", "‹");
    prev.addEventListener("click", (e) => { e.stopPropagation(); goTo(index - 1); });
    const next = el("button", "viewer-arrow next", "›");
    next.addEventListener("click", (e) => { e.stopPropagation(); goTo(index + 1); });
    overlay.appendChild(prev);
    overlay.appendChild(next);
    overlay.appendChild(counter);

    viewerNav = (e) => {
      if (e.key === "ArrowLeft") goTo(index - 1);
      else if (e.key === "ArrowRight") goTo(index + 1);
    };
  }

  // Tapping the backdrop (not the image) closes the viewer.
  stage.addEventListener("click", (e) => {
    if (e.target === stage || e.target === track) closeViewer();
  });

  overlay.hidden = false;
}

function closeViewer() {
  document.getElementById("viewer-overlay").hidden = true;
  document.getElementById("viewer-overlay").innerHTML = "";
  viewerNav = null;
}

/* -------------------------------- wiring --------------------------------- */

document.getElementById("btn-refresh").addEventListener("click", loadFeed);

document.getElementById("btn-window").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("menu-window");
  const willShow = menu.hidden;
  closeAllMenus();
  if (willShow) { buildWindowMenu(); menu.hidden = false; }
});

document.getElementById("btn-taxon").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("menu-taxon");
  const willShow = menu.hidden;
  closeAllMenus();
  if (willShow) { buildTaxonMenu(); menu.hidden = false; }
});

document.getElementById("btn-friends").addEventListener("click", openFriendsDialog);
document.getElementById("friends-close").addEventListener("click", () => {
  document.getElementById("friends-dialog").hidden = true;
});
document.getElementById("friends-dialog").addEventListener("click", (e) => {
  if (e.target.id === "friends-dialog") e.currentTarget.hidden = true;
});
document.getElementById("friends-add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("friends-input");
  const login = input.value.trim().toLowerCase().replace(/^@/, "");
  if (!login) return;
  const friends = Store.friends();
  if (!friends.includes(login)) {
    friends.push(login);
    Store.setFriends(friends);
    renderFriendsList();
    loadFeed();
  }
  input.value = "";
});

document.getElementById("btn-mode").addEventListener("click", () => {
  Store.setMode(Store.mode() === "grouped" ? "flat" : "grouped");
  render();
});

document.getElementById("btn-layout").addEventListener("click", () => {
  const order = ["large", "grid2", "grid3"];
  const next = order[(order.indexOf(Store.layout()) + 1) % order.length];
  Store.setLayout(next);
  render();
});

document.addEventListener("click", closeAllMenus);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeViewer();
    if (!document.getElementById("detail-overlay").hidden) closeDetail();
    document.getElementById("friends-dialog").hidden = true;
    closeAllMenus();
  } else if (viewerNav && !document.getElementById("viewer-overlay").hidden) {
    viewerNav(e);
  }
});

// back-to-top FAB
const fab = document.getElementById("back-to-top");
window.addEventListener("scroll", () => {
  fab.hidden = window.scrollY < 600;
});
fab.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

// go
loadFeed();
