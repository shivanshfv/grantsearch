// Loads data/grants.json, then filters, sorts and draws the table.
// Every filter is kept in the page address so a view can be bookmarked.

const form = document.getElementById("filters");
const table = document.getElementById("table");
const rowsEl = document.getElementById("rows");
const toggle = document.getElementById("toggle");
const showMore = document.getElementById("show-more");
const phone = window.matchMedia("(max-width: 720px)");

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 50; // rows drawn at a time
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Filter fields, in the order their chips appear. The names are also the
// names used in the page address, so do not rename them.
const FILTERS = {
  q: "Keyword", source: "Source", programme: "Programme or agency", status: "Status", new: "Show",
  type: "Type", from: "Deadline from", to: "Deadline to", min: "Budget from", max: "Budget to",
};
const MORE_FILTERS = ["type", "from", "to", "min", "max"]; // inside "More filters"
const SHORT_TYPES = {
  "Grant topic": "Grant", "Cascade funding call": "Cascade", "External action call": "External",
  "Cooperative Agreement": "Co-op", "Procurement Contract": "Contract",
};

let calls = [];
let shown = []; // the calls matching the current filters, in order
let limit = BATCH;
let sortKey = ""; // "" means the default order
let sortDir = "";
let dataDate = ""; // the day the data was fetched, e.g. "2026-01-31"
let weekAgo = "";
const today = isoDate(new Date(Date.now() - new Date().getTimezoneOffset() * 60000));
const in30Days = isoDate(new Date(Date.parse(today) + 30 * DAY));

drawSkeleton();
fetch("data/grants.json", { cache: "no-store" })
  .then((reply) => {
    if (!reply.ok) throw new Error("HTTP " + reply.status);
    return reply.json();
  })
  .then(start)
  .catch((error) => {
    console.error(error);
    form.hidden = true;
    document.getElementById("results").hidden = true;
    document.getElementById("error").hidden = false;
  });

function start(data) {
  calls = data.calls;
  for (const c of calls) {
    c.title = (c.title || c.identifier).normalize("NFKC"); // removes odd italic letters
    c.search = [c.title, c.identifier, c.call, c.programme, c.type].join(" ").toLowerCase();
  }
  const generated = new Date(data.generated_at);
  dataDate = data.generated_at.slice(0, 10);
  weekAgo = isoDate(new Date(generated - 7 * DAY));

  const time = generated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  document.getElementById("updated").textContent = "Last updated " + niceDate(isoDate(generated)) + ", " + time + ".";

  const hoursOld = (Date.now() - generated) / (60 * 60 * 1000);
  if (hoursOld > 48) {
    const box = document.getElementById("warning");
    box.textContent =
      "Warning: this data is " + Math.floor(hoursOld / 24) + " days old. The daily update has not been " +
      "running, so new calls and deadline changes may be missing.";
    box.hidden = false;
  }

  document.getElementById("n-total").textContent = calls.length;
  document.getElementById("n-today").textContent = calls.filter(isNewToday).length;
  document.getElementById("n-week").textContent = calls.filter(isNewThisWeek).length;
  document.getElementById("n-closing").textContent = calls.filter(isClosingSoon).length;
  document.getElementById("summary").hidden = false;

  fillSelect("programme");
  fillSelect("type");
  fillSelect("status");
  readAddress();
  if (!phone.matches && MORE_FILTERS.some(isActive)) setOpen(true);
  table.removeAttribute("aria-busy");
  draw();

  form.addEventListener("input", update);
  form.addEventListener("submit", (event) => event.preventDefault());
  window.addEventListener("popstate", () => { readAddress(); draw(); });
  phone.addEventListener("change", draw);
  toggle.addEventListener("click", () => setOpen(!form.classList.contains("open")));
  document.getElementById("clear").addEventListener("click", clearFilters);
  document.getElementById("empty-clear").addEventListener("click", clearFilters);
  showMore.addEventListener("click", () => { limit += BATCH; drawRows(limit - BATCH); });

  document.querySelectorAll("#summary button").forEach((button) => {
    button.addEventListener("click", () => {
      for (const name in FILTERS) form[name].value = "";
      form.new.value = button.dataset.show;
      update();
    });
  });
  document.querySelectorAll("th button").forEach((button) => {
    button.addEventListener("click", () => {
      const current = currentSort();
      sortDir = current.key === button.dataset.sort && current.dir === "asc" ? "desc" : "asc";
      sortKey = button.dataset.sort;
      update();
    });
  });

  // Keep the table's heading row pinned just below the pinned filter bar.
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--bar-height", phone.matches ? "0px" : form.offsetHeight + "px");
  }).observe(form);

  // On GitHub Pages, offer maintainers a shortcut to the "Run workflow" page.
  if (location.hostname.endsWith(".github.io")) {
    const link = document.getElementById("run-link");
    const owner = location.hostname.split(".")[0];
    const repo = location.pathname.split("/")[1];
    link.href = "https://github.com/" + owner + "/" + repo + "/actions/workflows/update.yml";
    link.hidden = false;
  }
}

function fillSelect(name) {
  const values = [...new Set(calls.map((c) => c[name]).filter(Boolean))].sort();
  for (const value of values) form[name].add(new Option(value, value));
}

function setOpen(open) {
  form.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", open);
}

// ---- Dates and numbers -------------------------------------------------------

function isoDate(date) { return date.toISOString().slice(0, 10); }

function niceDate(iso) { // "2026-11-23" -> "23 Nov 2026"
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return Number(day) + " " + MONTHS[month - 1] + " " + year;
}

function daysUntil(iso) { return Math.round((Date.parse(iso) - Date.parse(today)) / DAY); }

function relative(days) {
  if (days < 0) return "passed";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 60) return "in " + days + " days";
  return "in " + Math.round(days / 30.44) + " months";
}

function symbol(currency) { return currency === "USD" ? "$" : "€"; }

function shortMoney(amount, currency) { // 1200000 -> "€1.2M"
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, letter] of units) {
    if (amount >= size) {
      const value = amount / size;
      return symbol(currency) + (value < 10 ? Math.round(value * 10) / 10 : Math.round(value)) + letter;
    }
  }
  return symbol(currency) + amount;
}

function fullMoney(amount, currency) { return symbol(currency) + Number(amount).toLocaleString("en"); }

// ---- Filters <-> page address ------------------------------------------------

function isActive(name) { return form[name].value !== ""; }

function readAddress() {
  const params = new URLSearchParams(location.search);
  for (const name in FILTERS) {
    form[name].value = params.get(name) || "";
    if (form[name].selectedIndex === -1) form[name].selectedIndex = 0; // unknown option
  }
  sortKey = SORT_KEYS[params.get("sort")] ? params.get("sort") : "";
  sortDir = ["asc", "desc"].includes(params.get("dir")) ? params.get("dir") : "";
}

function writeAddress() {
  const params = new URLSearchParams();
  for (const name in FILTERS) {
    if (isActive(name)) params.set(name, form[name].value);
  }
  const usual = defaultSort();
  const current = currentSort();
  if (current.key !== usual.key) params.set("sort", current.key);
  if (current.dir !== (current.key === usual.key ? usual.dir : "asc")) params.set("dir", current.dir);
  const query = params.toString();
  history.replaceState(null, "", query ? "?" + query : location.pathname);
}

function update() {
  limit = BATCH;
  writeAddress();
  draw();
}

function clearFilters() {
  for (const name in FILTERS) form[name].value = "";
  update();
}

// ---- Filtering and sorting ----------------------------------------------------

function isNewToday(c) { return c.first_seen !== "" && c.first_seen === dataDate; }
function isNewThisWeek(c) { return c.first_seen !== "" && c.first_seen > weekAgo; }
function isChanged(c) { return c.changed_on !== "" && c.changed_on > weekAgo; }
function isClosingSoon(c) { return c.next_deadline !== "" && c.next_deadline >= today && c.next_deadline <= in30Days; }

function matches(c) {
  const f = form;
  const words = f.q.value.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every((word) => c.search.includes(word))) return false;

  if (f.source.value && c.source !== f.source.value) return false;
  if (f.programme.value && c.programme !== f.programme.value) return false;
  if (f.type.value && c.type !== f.type.value) return false;
  if (f.status.value && c.status !== f.status.value) return false;

  if (f.new.value === "today" && !isNewToday(c)) return false;
  if (f.new.value === "week" && !isNewThisWeek(c)) return false;
  if (f.new.value === "changed" && !isChanged(c)) return false;
  if (f.new.value === "closing" && !isClosingSoon(c)) return false;

  if (f.from.value || f.to.value) {
    if (!c.next_deadline) return false;
    if (f.from.value && c.next_deadline < f.from.value) return false;
    if (f.to.value && c.next_deadline > f.to.value) return false;
  }
  if (f.min.value || f.max.value) {
    if (c.budget === null) return false;
    if (f.min.value && c.budget < Number(f.min.value)) return false;
    if (f.max.value && c.budget > Number(f.max.value)) return false;
  }
  return true;
}

const SORT_KEYS = {
  deadline: (c) => c.next_deadline,
  title: (c) => c.title.toLowerCase(),
  programme: (c) => c.programme.toLowerCase(),
  type: (c) => c.type,
  status: (c) => c.status,
  opening: (c) => c.opening_date,
  budget: (c) => c.budget,
  first_seen: (c) => c.first_seen,
};

// Soonest deadline first, except that the "New" views list the newest first.
function defaultSort() {
  const newest = ["today", "week"].includes(form.new.value);
  return newest ? { key: "first_seen", dir: "desc" } : { key: "deadline", dir: "asc" };
}

function currentSort() {
  const usual = defaultSort();
  const key = sortKey || usual.key;
  return { key, dir: sortDir || (key === usual.key ? usual.dir : "asc") };
}

function sorted(list) {
  const { key, dir } = currentSort();
  const value = SORT_KEYS[key];
  const flip = dir === "desc" ? -1 : 1;
  return list.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const xEmpty = x === "" || x === null;
    const yEmpty = y === "" || y === null;
    if (xEmpty || yEmpty) return xEmpty - yEmpty; // blanks always go last
    if (x < y) return -flip;
    if (x > y) return flip;
    return 0;
  });
}

// ---- Drawing -----------------------------------------------------------------

function make(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function drawSkeleton() {
  for (let i = 0; i < 10; i++) {
    const tr = make("tr", "", "skeleton");
    const td = make("td");
    td.colSpan = 7;
    td.append(make("span"), make("span"));
    tr.append(td);
    rowsEl.append(tr);
  }
}

function draw() {
  shown = sorted(calls.filter(matches));
  document.getElementById("count").textContent = shown.length + " of " + calls.length + " calls";
  document.getElementById("empty").hidden = shown.length > 0;
  table.hidden = shown.length === 0;
  drawChips();
  drawNote();
  drawSortArrows();
  rowsEl.replaceChildren();
  drawRows(0);
}

function chipText(name) {
  const field = form[name];
  let value = field.value;
  if (field.tagName === "SELECT") value = field.selectedOptions[0].text;
  if (field.type === "date") value = niceDate(value);
  if (field.type === "number") value = Number(value).toLocaleString("en");
  return name === "new" ? value : FILTERS[name] + ": " + value;
}

function drawChips() {
  const chips = document.getElementById("chips");
  chips.replaceChildren();
  const active = Object.keys(FILTERS).filter(isActive);
  for (const name of active) {
    const button = make("button", chipText(name));
    button.type = "button";
    button.setAttribute("aria-label", "Remove filter " + chipText(name));
    button.addEventListener("click", () => { form[name].value = ""; update(); });
    const item = make("li");
    item.append(button);
    chips.append(item);
  }
  document.getElementById("clear").hidden = active.length === 0;

  // On phones one button opens every filter; on desktop only the extra ones.
  const hiddenOnes = phone.matches ? active.filter((name) => name !== "q") : active.filter((name) => MORE_FILTERS.includes(name));
  toggle.textContent = (phone.matches ? "Filters" : "More filters") + (hiddenOnes.length ? " (" + hiddenOnes.length + ")" : "");
}

function drawNote() {
  const notes = [];
  if (isActive("from") || isActive("to")) notes.push("Calls with no deadline listed are hidden while a deadline filter is on.");
  if (isActive("min") || isActive("max")) notes.push("Calls with no published budget are hidden while a budget filter is on. Amounts are compared as published: euros and dollars are not converted.");
  const note = document.getElementById("note");
  note.textContent = notes.join(" ");
  note.hidden = notes.length === 0;
}

function drawSortArrows() {
  const { key, dir } = currentSort();
  document.querySelectorAll("th button").forEach((button) => {
    const active = button.dataset.sort === key;
    button.parentElement.setAttribute("aria-sort", active ? (dir === "asc" ? "ascending" : "descending") : "none");
    button.querySelector(".arrow")?.remove();
    if (active) {
      const arrow = make("span", dir === "asc" ? " ▲" : " ▼", "arrow");
      arrow.setAttribute("aria-hidden", "true");
      button.append(arrow);
    }
  });
}

function drawRows(from) {
  const fragment = document.createDocumentFragment();
  const batch = shown.slice(from, limit).map(drawRow);
  fragment.append(...batch);
  rowsEl.append(fragment);

  // Offer "more" only on titles that are actually cut off.
  for (const tr of batch) {
    const title = tr.querySelector(".title");
    tr.querySelector(".more-title").hidden = title.scrollHeight <= title.clientHeight + 1;
  }

  const left = shown.length - limit;
  showMore.hidden = left <= 0;
  showMore.textContent = "Show " + Math.min(BATCH, left) + " more (" + left + " not shown)";
}

function cell(className, label) {
  const td = make("td", "", className);
  if (label) td.dataset.label = label;
  return td;
}

// A small button that shows or hides part of a row.
function expander(closedText, openText, onToggle) {
  const button = make("button", closedText, "link");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", open);
    button.textContent = open ? openText : closedText;
    onToggle(open);
  });
  return button;
}

function drawRow(c) {
  const tr = make("tr");

  // Call: title, then identifier and badges on a small second line.
  const call = cell("call");
  const link = make("a", c.title, "title");
  link.href = c.url;
  link.target = "_blank";
  link.rel = "noopener";
  const sub = make("span", c.identifier, "sub");
  const more = expander("more", "less", (open) => tr.classList.toggle("expanded", open));
  more.classList.add("more-title");
  sub.append(more);
  if (isNewThisWeek(c)) {
    const badge = make("span", "New", "badge new");
    badge.title = "First listed " + niceDate(c.first_seen);
    sub.append(badge);
  }
  if (isChanged(c)) sub.append(make("span", "Changed", "badge changed"));
  call.append(link, sub);
  if (isChanged(c)) call.append(make("span", c.change.replaceAll("->", "→").replace(/\d{4}-\d\d-\d\d/g, niceDate) +" (" + niceDate(c.changed_on) + ")", "sub"));
  tr.append(call);

  // Programme: short code, full name on hover and for screen readers.
  const programme = cell("programme");
  const code = /\(([^()]+)\)\s*$/.exec(c.programme);
  const tag = make("span", code ? code[1].split(" - ")[0].trim() : c.programme, "tag");
  tag.title = c.programme;
  tag.setAttribute("aria-label", c.programme);
  programme.append(tag);
  tr.append(programme);

  const type = cell("type");
  const typeTag = make("span", SHORT_TYPES[c.type] || c.type, "tag");
  typeTag.title = c.type;
  type.append(typeTag, make("span", c.source, "sub"));
  tr.append(type);

  const status = cell("status");
  status.append(make("span", c.status, "pill" + (c.status === "Open" ? " open" : "")));
  tr.append(status);

  const opens = cell("opens date", "Opens");
  opens.append(c.opening_date ? niceDate(c.opening_date) : dash("No opening date"));
  tr.append(opens);

  // Deadline: next date, how far away it is, and any further dates on request.
  const deadline = cell("deadline", "Deadline");
  if (c.next_deadline) {
    const days = daysUntil(c.next_deadline);
    if (days <= 14) deadline.classList.add("soon");
    deadline.append(make("span", niceDate(c.next_deadline), "date"));
    const when = make("span", relative(days), "sub when");
    const others = c.deadlines.filter((d) => d !== c.next_deadline);
    if (others.length) {
      const list = make("ul", "", "others");
      list.hidden = true;
      for (const d of others) list.append(make("li", niceDate(d)));
      when.append(expander("+" + others.length + " more", "hide", (open) => { list.hidden = !open; }));
      deadline.append(when, list);
    } else {
      deadline.append(when);
    }
  } else {
    deadline.append(dash("No deadline listed"));
  }
  tr.append(deadline);

  const budget = cell("budget number", "Budget");
  if (c.budget === null) {
    budget.append(dash("Not published"));
  } else {
    const amount = make("span", shortMoney(c.budget, c.currency));
    amount.title = fullMoney(c.budget, c.currency);
    amount.setAttribute("aria-label", fullMoney(c.budget, c.currency));
    budget.append(amount);
  }
  tr.append(budget);
  return tr;
}

function dash(meaning) {
  const span = make("span", "", "dash");
  const mark = make("span", "–");
  mark.setAttribute("aria-hidden", "true");
  span.append(mark, make("span", meaning, "sr-only"));
  return span;
}
