"""Fetch open and forthcoming grant calls from the EU and from Grants.gov (US)
and write them to docs/data/.

Run with:  python fetch_grants.py

It writes three files (JSON, CSV, XLSX). If anything goes wrong, it stops
with an error and leaves the existing files untouched.
"""

import csv
import json
import os
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook

TIMEOUT_SECONDS = 180
ATTEMPTS = 3

DATA_DIR = Path(__file__).parent / "docs" / "data"
JSON_FILE = DATA_DIR / "grants.json"
CSV_FILE = DATA_DIR / "grants.csv"
XLSX_FILE = DATA_DIR / "grants.xlsx"


# ---- Shared helpers ----------------------------------------------------------

def user_agent():
    agent = "grant-calls-daily-fetcher/1.0 (one run per day)"
    repo = os.environ.get("GITHUB_REPOSITORY")  # set automatically on GitHub
    if repo:
        agent += f" +https://github.com/{repo}"
    return agent


def post(url, body, content_type):
    """POST to an API and return the parsed JSON reply, retrying on errors."""
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": content_type, "User-Agent": user_agent()}
    )
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as reply:
                return json.load(reply)
        except Exception as error:
            print(f"  attempt {attempt} failed: {error}")
            if attempt == ATTEMPTS:
                raise
            time.sleep(10 * attempt)


def new_call(url, today, deadlines, **fields):
    """One record in the shape used by the page and the downloads.

    Returns None for calls whose last deadline has passed: both sources keep
    listing old calls as open or forthcoming long after they closed.
    """
    deadlines = sorted(set(deadlines))
    if deadlines and deadlines[-1] < today:
        return None
    upcoming = [d for d in deadlines if d >= today]
    return {
        "url": url,
        **fields,
        "deadlines": deadlines,
        "next_deadline": upcoming[0] if upcoming else "",
        "first_seen": "",
        "changed_on": "",
        "change": "",
    }


def to_amount(value):
    """A whole number, or None if the value is missing or not a number."""
    try:
        return round(float(value))
    except (TypeError, ValueError):
        return None


# ---- Source 1: EU Funding & Tenders Portal -----------------------------------

EU_API = "https://api.tech.ec.europa.eu/search-api/prod/rest"
EU_PAGE_SIZE = 100
EU_PAUSE_SECONDS = 2

# Codes used by the EU portal.
EU_TYPES = {"1": "Grant topic", "2": "External action call", "8": "Cascade funding call"}
EU_STATUSES = {"31094501": "Forthcoming", "31094502": "Open"}
EU_QUERY = {
    "bool": {
        "must": [
            {"terms": {"type": list(EU_TYPES)}},
            {"terms": {"status": list(EU_STATUSES)}},
        ]
    }
}


def eu_post(path, params):
    boundary = "----" + uuid.uuid4().hex
    body = b""
    for name, value in (("query", EU_QUERY), ("languages", ["en"])):
        body += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"; filename="blob"\r\n'
            "Content-Type: application/json\r\n\r\n"
            f"{json.dumps(value)}\r\n"
        ).encode()
    body += f"--{boundary}--\r\n".encode()
    url = f"{EU_API}/{path}?apiKey=SEDIA&text=***{params}"
    return post(url, body, f"multipart/form-data; boundary={boundary}")


def eu_fetch_all():
    """Download every page of EU results."""
    results = []
    page = 1
    while True:
        data = eu_post("search", f"&pageSize={EU_PAGE_SIZE}&pageNumber={page}")
        total = data["totalResults"]
        results += data["results"]
        print(f"EU page {page}: {len(results)} of {total}")
        if not data["results"] or len(results) >= total:
            break
        page += 1
        time.sleep(EU_PAUSE_SECONDS)
    if not results:
        sys.exit("ERROR: the EU API returned zero results. Existing data left untouched.")
    if len(results) < total:
        sys.exit(f"ERROR: only got {len(results)} of {total} EU results. Existing data left untouched.")
    return results


def eu_fetch_programme_names():
    """The EU API returns programmes as numbers; this gets the readable names."""
    time.sleep(EU_PAUSE_SECONDS)
    data = eu_post("facet", "")
    for facet in data["facets"]:
        if facet["name"] == "frameworkProgramme":
            return {v["rawValue"]: " ".join(v["value"].split()) for v in facet["values"]}
    sys.exit("ERROR: could not find programme names in the EU API reply.")


def first(metadata, field):
    values = metadata.get(field) or [""]
    return (values[0] or "").strip()


def eu_budget(metadata, identifier):
    """Budget in euros, or None if the API does not give one."""
    budget = first(metadata, "budget")
    if budget:
        return to_amount(budget)
    # Grant topics keep budgets in a table covering every topic of the call.
    overview = first(metadata, "budgetOverview")
    if not overview:
        return None
    amounts = [
        float(amount)
        for actions in json.loads(overview).get("budgetTopicActionMap", {}).values()
        for action in actions
        if (action.get("action") or "").startswith(identifier + " ")
        for amount in (action.get("budgetYearMap") or {}).values()
        if amount
    ]
    return round(sum(amounts)) if amounts else None


def eu_calls(today):
    results = eu_fetch_all()
    programme_names = eu_fetch_programme_names()
    calls = {}
    for result in results:
        m = result["metadata"]
        url = result.get("url") or first(m, "url")
        kind = first(m, "type")
        if kind == "8" and first(m, "callccm2Id"):
            # The link the API gives for cascade calls opens an empty page.
            # The working link ends in the call's own number instead.
            url = url.rsplit("/", 1)[0] + "/" + first(m, "callccm2Id")
        deadlines = [d[:10] for d in m.get("deadlineDate") or [] if d]

        if url in calls:  # same call listed twice: merge the deadlines
            merged = sorted(set(calls[url]["deadlines"]) | set(deadlines))
            calls[url]["deadlines"] = merged
            calls[url]["next_deadline"] = next((d for d in merged if d >= today), "")
            continue

        identifier = first(m, "identifier")
        title = first(m, "title")
        if kind == "8":  # cascade calls: "title" is the parent topic's title
            title = first(m, "callTitle") or first(m, "caName") or title
        programme = first(m, "frameworkProgramme")
        status = first(m, "status")

        call = new_call(
            url, today, deadlines,
            source="EU",
            identifier=identifier,
            title=" ".join(title.split()),
            type=EU_TYPES.get(kind, kind),
            programme=programme_names.get(programme, programme),
            call=first(m, "callIdentifier"),
            status=EU_STATUSES.get(status, status),
            opening_date=first(m, "startDate")[:10],
            deadline_model=first(m, "deadlineModel"),
            budget=eu_budget(m, identifier),
            currency="EUR",
        )
        if call:
            calls[url] = call
    if not calls:
        sys.exit("ERROR: no current EU calls after filtering. Existing data left untouched.")
    return calls


# ---- Source 2: Grants.gov (United States) --------------------------------------

US_API = "https://api.grants.gov/v1/api"
US_PAGE_SIZE = 500
US_PAUSE_SECONDS = 0.5
US_STATUSES = {"posted": "Open", "forecasted": "Forthcoming"}
US_MAX_FAILED_SHARE = 0.05  # stop if more than 5% of detail lookups fail


def us_post(path, payload):
    data = post(f"{US_API}/{path}", json.dumps(payload).encode(), "application/json")
    if data.get("errorcode") != 0:
        raise RuntimeError(f"Grants.gov said: {data.get('msg')}")
    return data["data"]


def us_fetch_list():
    """Download the list of posted and forecasted opportunities."""
    hits = []
    while True:
        data = us_post("search2", {
            "rows": US_PAGE_SIZE, "startRecordNum": len(hits),
            "oppStatuses": "forecasted|posted", "keyword": "",
        })
        total = data["hitCount"]
        hits += data["oppHits"]
        print(f"US list: {len(hits)} of {total}")
        if not data["oppHits"] or len(hits) >= total:
            break
        time.sleep(US_PAUSE_SECONDS)
    if not hits:
        sys.exit("ERROR: Grants.gov returned zero results. Existing data left untouched.")
    if len(hits) < total:
        sys.exit(f"ERROR: only got {len(hits)} of {total} US results. Existing data left untouched.")
    return hits


def us_date(text):
    """Grants.gov detail dates look like '2028-01-07-00-00-00'."""
    return (text or "")[:10]


def us_call(hit, today):
    """Look up one opportunity's details (budget and dates) and build its record."""
    detail = us_post("fetchOpportunity", {"opportunityId": int(hit["id"])})
    forecast = hit["oppStatus"] == "forecasted"
    info = detail.get("forecast" if forecast else "synopsis") or {}

    if forecast:  # forecasts only have estimated dates
        opening = us_date(info.get("estSynopsisPostingDateStr"))
        deadline = us_date(info.get("estApplicationResponseDateStr"))
    else:
        opening = us_date(info.get("postingDateStr"))
        deadline = us_date(info.get("responseDateStr"))

    agency_code = hit["agencyCode"].split("-")[0]
    agency = (detail.get("topAgencyDetails") or {}).get("agencyName") or hit["agency"]
    instruments = info.get("fundingInstruments") or [{}]

    return new_call(
        f"https://www.grants.gov/search-results-detail/{hit['id']}", today,
        [deadline] if deadline else [],
        source="US",
        identifier=hit["number"],
        title=" ".join(hit["title"].split()),
        type=instruments[0].get("description") or "Grant",
        programme=f"{' '.join(agency.split())} ({agency_code})",
        call=hit["agency"],  # the office within the agency
        status=US_STATUSES[hit["oppStatus"]],
        opening_date=opening,
        deadline_model="estimated" if forecast else "",
        budget=to_amount(info.get("estimatedFunding")),
        currency="USD",
    )


def us_calls(today, previous):
    hits = us_fetch_list()
    calls = {}
    failed = 0
    for number, hit in enumerate(hits, start=1):
        if number % 100 == 0:
            print(f"US details: {number} of {len(hits)}")
        time.sleep(US_PAUSE_SECONDS)
        try:
            call = us_call(hit, today)
        except Exception as error:
            # One bad record should not sink the run: reuse yesterday's copy.
            failed += 1
            print(f"  could not get details for {hit['number']}: {error}")
            call = (previous or {}).get(f"https://www.grants.gov/search-results-detail/{hit['id']}")
        if call:
            calls[call["url"]] = call
    if failed > len(hits) * US_MAX_FAILED_SHARE:
        sys.exit(f"ERROR: {failed} of {len(hits)} US detail lookups failed. Existing data left untouched.")
    if not calls:
        sys.exit("ERROR: no current US calls after filtering. Existing data left untouched.")
    return calls


# ---- Change tracking and output ------------------------------------------------

def track_changes(calls, previous, today):
    """Fill in first-seen dates and flag deadline or status changes."""
    if previous is None:
        return  # very first run: nothing to compare with, so nothing is "new"
    for url, call in calls.items():
        old = previous.get(url)
        if old is None:
            call["first_seen"] = today
            continue
        call["first_seen"] = old.get("first_seen", "")
        call["changed_on"] = old.get("changed_on", "")
        call["change"] = old.get("change", "")
        notes = []
        if old["deadlines"] != call["deadlines"]:
            before = ", ".join(old["deadlines"]) or "none"
            after = ", ".join(call["deadlines"]) or "none"
            notes.append(f"Deadline: {before} -> {after}")
        if old["status"] != call["status"]:
            notes.append(f"Status: {old['status']} -> {call['status']}")
        if notes:
            call["changed_on"] = today
            call["change"] = "; ".join(notes)


COLUMNS = [
    ("Source", "source"),
    ("Identifier", "identifier"),
    ("Title", "title"),
    ("Type", "type"),
    ("Programme or agency", "programme"),
    ("Parent call or office", "call"),
    ("Status", "status"),
    ("Opening date", "opening_date"),
    ("Next deadline", "next_deadline"),
    ("All deadlines", "deadlines"),
    ("Deadline model", "deadline_model"),
    ("Budget", "budget"),
    ("Currency", "currency"),
    ("First seen", "first_seen"),
    ("Changed on", "changed_on"),
    ("Change", "change"),
    ("Link", "url"),
]


def table_rows(calls):
    rows = [[title for title, _ in COLUMNS]]
    for call in calls:
        row = [call[key] for _, key in COLUMNS]
        rows.append([", ".join(v) if isinstance(v, list) else v for v in row])
    return rows


def write_files(calls, now):
    calls = sorted(calls.values(), key=lambda c: (c["next_deadline"] or "9999", c["identifier"]))
    rows = table_rows(calls)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    JSON_FILE.write_text(
        json.dumps({"generated_at": now, "calls": calls}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    # "utf-8-sig" makes Excel open accented characters correctly.
    with open(CSV_FILE, "w", newline="", encoding="utf-8-sig") as f:
        csv.writer(f).writerows(rows)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Grants"
    for row in rows:
        sheet.append(row)
    sheet.freeze_panes = "A2"
    workbook.save(XLSX_FILE)


def main():
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")

    previous = None
    if JSON_FILE.exists():
        old_calls = json.loads(JSON_FILE.read_text(encoding="utf-8"))["calls"]
        previous = {c["url"]: c for c in old_calls}

    # If either source fails, the script stops here and nothing is written.
    calls = eu_calls(today)
    calls.update(us_calls(today, previous))

    track_changes(calls, previous, today)
    write_files(calls, now.strftime("%Y-%m-%dT%H:%M:%SZ"))

    new = sum(1 for c in calls.values() if c["first_seen"] == today)
    changed = sum(1 for c in calls.values() if c["changed_on"] == today)
    eu = sum(1 for c in calls.values() if c["source"] == "EU")
    print(f"Done: {len(calls)} calls written ({eu} EU, {len(calls) - eu} US; {new} new, {changed} changed today).")


if __name__ == "__main__":
    main()
