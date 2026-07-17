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

const DEFAULT_FRIENDS = [
  "andrewclaassen", "antye", "average_plant_enjoyer", "badbackbum",
  "betweenthelyons", "bluemayo", "crislikesplants", "crownthesun821",
  "diyhrt", "dvanheule", "elafentsheep", "happyhiho", "ianmatthews",
  "itsmemarlo", "julien9uwr", "kcelshoff", "lichenqueen", "lindseyj2022",
  "luke42776", "northtravels", "ocean_beach_goth", "richardandrews",
  "sanjoaquinserpents", "scientistsmom", "slowswakey", "suzannesannwald",
  "tadd_k", "thehyphaemovement", "theking926", "trevorogilvie",
];

/* ------------------------------- persistence ----------------------------- */

const Store = {
  friends() {
    try {
      const raw = localStorage.getItem("friends");
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [...DEFAULT_FRIENDS];
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

function buildPhotoWrap(obs, size, withAvatar) {
  const wrap = el("div", "photo-wrap");
  const photos = obs.photos || [];
  const first = photos[0];
  const img = el("img");
  img.loading = "lazy";
  img.src = first ? photoSize(first.url, size) : "";
  img.alt = (obs.taxon && (obs.taxon.preferred_common_name || obs.taxon.name)) || "observation";
  wrap.appendChild(img);

  if (photos.length > 1) {
    const pill = el("div", "count-pill", `1/${photos.length}`);
    wrap.appendChild(pill);
  }
  if (withAvatar && obs.user && obs.user.icon_url) {
    const av = el("img", "avatar-badge");
    av.src = obs.user.icon_url;
    av.alt = obs.user.login || "";
    wrap.appendChild(av);
  }
  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    openViewer(photos, 0);
  });
  return wrap;
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

function openDetail(obs) {
  const list = sameObserverList(obs);
  let index = list.findIndex((o) => o.id === obs.id);
  if (index < 0) index = 0;
  const overlay = document.getElementById("detail-overlay");

  function draw() {
    const o = list[index];
    overlay.innerHTML = "";
    const panel = el("div", "detail");

    // top bar
    const top = el("div", "detail-top");
    const back = el("button", "icon-btn", "←");
    back.addEventListener("click", closeDetail);
    top.appendChild(back);
    top.appendChild(el("div", "login", (o.user && o.user.login) || "unknown"));
    const link = document.createElement("a");
    link.href = o.uri || `https://www.inaturalist.org/observations/${o.id}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View on iNat ↗";
    top.appendChild(link);
    panel.appendChild(top);

    const body = el("div", "detail-body");

    // nav between this observer's observations
    if (list.length > 1) {
      const nav = el("div", "detail-nav");
      const prev = el("button", null, "← Prev");
      prev.disabled = index === 0;
      prev.addEventListener("click", () => { if (index > 0) { index--; draw(); } });
      const pos = el("span", null, `${index + 1} of ${list.length}`);
      const next = el("button", null, "Next →");
      next.disabled = index === list.length - 1;
      next.addEventListener("click", () => { if (index < list.length - 1) { index++; draw(); } });
      nav.appendChild(prev); nav.appendChild(pos); nav.appendChild(next);
      body.appendChild(nav);
    }

    // main photo
    const photos = o.photos || [];
    if (photos.length > 0) {
      const pw = el("div", "detail-photo");
      const img = el("img");
      img.src = photoSize(photos[0].url, "large");
      img.alt = "";
      img.addEventListener("click", () => openViewer(photos, 0));
      pw.appendChild(img);
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

    panel.appendChild(body);
    overlay.appendChild(panel);
  }

  draw();
  overlay.hidden = false;
}

function closeDetail() {
  document.getElementById("detail-overlay").hidden = true;
  document.getElementById("detail-overlay").innerHTML = "";
}

/* -------------------------- fullscreen viewer ---------------------------- */

function openViewer(photos, startIndex) {
  if (!photos || photos.length === 0) return;
  let index = startIndex || 0;
  const overlay = document.getElementById("viewer-overlay");

  function draw() {
    overlay.innerHTML = "";
    const close = el("button", "viewer-close", "✕");
    close.addEventListener("click", closeViewer);
    overlay.appendChild(close);

    const img = el("img");
    img.src = photoSize(photos[index].url, "large");
    img.alt = "";
    overlay.appendChild(img);

    if (photos.length > 1) {
      const prev = el("button", "viewer-arrow prev", "‹");
      prev.addEventListener("click", (e) => {
        e.stopPropagation();
        index = (index - 1 + photos.length) % photos.length; draw();
      });
      const next = el("button", "viewer-arrow next", "›");
      next.addEventListener("click", (e) => {
        e.stopPropagation();
        index = (index + 1) % photos.length; draw();
      });
      overlay.appendChild(prev);
      overlay.appendChild(next);
      overlay.appendChild(el("div", "viewer-counter", `${index + 1} / ${photos.length}`));
    }
  }

  draw();
  overlay.hidden = false;
}

function closeViewer() {
  document.getElementById("viewer-overlay").hidden = true;
  document.getElementById("viewer-overlay").innerHTML = "";
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
