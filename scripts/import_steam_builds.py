#!/usr/bin/env python3
"""Refresh the static index of public Dota 2 Hero Builds from Steam Community."""

from __future__ import annotations

import concurrent.futures
import html
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "index.html"
OUTPUT = ROOT / "steam-builds.json"
BASE = "https://steamcommunity.com/app/570/guides/"
USER_AGENT = "Mozilla/5.0 (compatible; DotaLaneSteamBuildIndex/1.0)"
PER_HERO = 20
PAGES_PER_QUERY = 4

# Some Steam pages don't expose a hero tag for these names. Search stays scoped
# to Hero Builds (filetype=12), then the result text is checked against the hero.
SEARCH_ALIASES = {
    "Io": ("Io", "Wisp"),
    "Necrophos": ("Necrophos", "Necrolyte"),
    "Terrorblade": ("Terrorblade", "Soul Keeper"),
    "Windranger": ("Windranger", "Windrunner"),
    "Wraith King": ("Wraith King", "Skeleton King"),
    "Underlord": ("Underlord", "Abyssal Underlord"),
}


def fetch(url: str) -> str:
    for attempt in range(4):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=25) as response:
                return response.read().decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError) as error:
            if attempt == 3:
                raise RuntimeError(f"Steam request failed: {url}: {error}") from error
            time.sleep(1.5 * (attempt + 1))
    raise AssertionError("unreachable")


def clean(fragment: str) -> str:
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(fragment)).strip()


def read_heroes() -> list[str]:
    source = PAGE.read_text(encoding="utf-8")
    match = re.search(r"const heroes=(\[.*?\]);", source, flags=re.S)
    if not match:
        raise RuntimeError(f"Could not find the hero catalog in {PAGE}")
    return [hero["name"] for hero in json.loads(match.group(1))]


def steam_hero_tags() -> set[str]:
    page = fetch(BASE + "?browsefilter=trend&browsesort=trend")
    return {
        html.unescape(match)
        for match in re.findall(
            r'name="requiredtags\[\]"[^>]*value="([^"]+)"', page
        )
    }


def query_url(hero: str, page: int, use_tag: bool) -> str:
    params = [
        ("browsefilter", "mostrecent"),
        ("browsesort", "mostrecent"),
        ("filetype", "12"),
        ("numperpage", "30"),
        ("p", str(page)),
    ]
    if use_tag:
        params.append(("requiredtags[0]", hero))
    else:
        params.append(("searchText", hero))
    return BASE + "?" + urlencode(params)


def relevant_fallback(hero: str, text: str) -> bool:
    terms = SEARCH_ALIASES.get(hero, (hero,))
    for term in terms:
        if re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", text, re.I):
            return True
    return False


def parse_performance(text: str) -> tuple[int | None, float | None, str | None]:
    """Extract performance claims shown in public guide text; never invent stats."""
    matches = re.search(
        r"(?<![\w.])(\d[\d,.]*\s*[kK]?)\s*(?:ranked\s+)?(?:matches|games|матч(?:ей|а|и)?|игр(?:ы|а)?)(?!\w)",
        text,
        flags=re.I,
    )
    win_rate = re.search(
        r"(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*%\s*(?:wr|win\s*rate|винрейт)",
        text,
        flags=re.I,
    )
    count: int | None = None
    if matches:
        amount = matches.group(1).replace(",", "").replace(" ", "")
        if amount.lower().endswith("k"):
            count = round(float(amount[:-1]) * 1000)
        else:
            count = int(float(amount))
    rate = float(win_rate.group(1)) if win_rate else None
    if rate is not None and not 0 < rate <= 100:
        rate = None
    source = None
    if count is not None or rate is not None:
        source = "Dota2ProTracker" if re.search(r"D2PT|Dota2ProTracker", text, re.I) else "Описание гайда"
    return count, rate, source


def parse_items(page: str, hero: str, use_tag: bool) -> list[dict[str, str | None]]:
    results: list[dict[str, str | None]] = []
    anchors = re.finditer(
        r"<a\b(?=[^>]*class=\"[^\"]*workshopItemCollection[^\"]*\")[^>]*>",
        page,
        flags=re.I,
    )
    for anchor in anchors:
        start, end = anchor.span()
        close = page.find("</a>", end)
        if close < 0:
            continue
        opening = anchor.group(0)
        block = page[end:close]
        href_match = re.search(r'href="([^"]*sharedfiles/filedetails/\?id=\d+[^"]*)"', opening)
        title_match = re.search(
            r'class="workshopItemTitle"[^>]*>(.*?)<div class="workshopItemAuthorLine"',
            block,
            flags=re.S | re.I,
        )
        if not href_match or not title_match:
            continue

        title = clean(title_match.group(1))
        title = re.sub(r"^Hero Builds\s*", "", title, flags=re.I).strip()
        author_match = re.search(
            r'class="workshopItemAuthorName"[^>]*>(.*?)</span>',
            block,
            flags=re.S | re.I,
        )
        desc_match = re.search(
            r'class="workshopItemShortDesc"[^>]*>(.*?)</div>',
            block,
            flags=re.S | re.I,
        )
        author = clean(author_match.group(1)) if author_match else ""
        description = clean(desc_match.group(1)) if desc_match else ""
        if not use_tag and not relevant_fallback(hero, f"{title} {description}"):
            continue

        url = html.unescape(href_match.group(1)).replace("&amp;", "&")
        file_id = parse_qs(urlparse(url).query).get("id", [""])[0]
        if not file_id:
            continue

        text = f"{title} {description}"
        position_match = re.search(
            r"\b(?:pos(?:ition)?|позици[яи])\s*[:#-]?\s*([1-5])\b",
            text,
            flags=re.I,
        )
        positions: set[str] = set()
        if position_match:
            positions.add(position_match.group(1))
        else:
            title_lower = title.lower()
            if re.search(r"\bcarry\b|керри", title_lower):
                positions.add("1")
            if re.search(r"\bmid\b|\bmidlane\b|мид", title_lower):
                positions.add("2")
            if re.search(r"\boff[\s-]?lane\b|оффлейн|хард", title_lower):
                positions.add("3")
            if re.search(r"\bsupport\b|поддержк", title_lower):
                positions.update(("4", "5"))
            if re.search(r"\bcore\b|основа", title_lower):
                positions.update(("1", "2", "3"))
        patch_match = re.search(r"\b7\.\d+[a-z]?\b", title, flags=re.I)
        tags = ["Hero Build"]
        if patch_match:
            tags.append(patch_match.group(0))
        summary = (f"Автор: {author}. " if author else "") + (
            description or "Публичная сборка героя из Steam Community."
        )
        match_count, win_rate, stats_source = parse_performance(f"{title} {description}")
        results.append(
            {
                "id": file_id,
                "hero": hero,
                "role": next(iter(positions)) if len(positions) == 1 else None,
                "roles": sorted(positions, key=int),
                "title": title or f"{hero} — Hero Build",
                "desc": summary[:320],
                "url": url,
                "tags": tags,
                "source": "steam",
                "match_count": match_count,
                "win_rate": win_rate,
                "stats_source": stats_source,
            }
        )
    return results


def collect_hero(hero: str, tags: set[str]) -> tuple[str, list[dict[str, str | None]]]:
    use_tag = hero in tags
    results: list[dict[str, str | None]] = []
    seen: set[str] = set()
    for page_number in range(1, PAGES_PER_QUERY + 1):
        page = fetch(query_url(hero, page_number, use_tag))
        for item in parse_items(page, hero, use_tag):
            if item["id"] not in seen:
                seen.add(str(item["id"]))
                results.append(item)
                if len(results) >= PER_HERO:
                    break
        if len(results) >= PER_HERO:
            break

    # A stale Steam hero tag can occasionally have no current public results.
    if use_tag and not results:
        for page_number in range(1, PAGES_PER_QUERY + 1):
            page = fetch(query_url(hero, page_number, False))
            for item in parse_items(page, hero, False):
                if item["id"] not in seen:
                    seen.add(str(item["id"]))
                    results.append(item)
                    if len(results) >= PER_HERO:
                        break
            if len(results) >= PER_HERO:
                break
    return hero, results[:PER_HERO]


def main() -> None:
    heroes = read_heroes()
    tags = steam_hero_tags()
    print(f"Steam hero filters: {sum(hero in tags for hero in heroes)}/{len(heroes)}")
    collected: dict[str, list[dict[str, str | None]]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(collect_hero, hero, tags): hero for hero in heroes}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            hero, items = future.result()
            collected[hero] = items
            if index % 10 == 0 or index == len(heroes):
                print(f"Fetched {index}/{len(heroes)} heroes")

    # Steam may return the same item under several hero tags. Keep its strongest
    # hero match so feed counts and per-hero filters do not duplicate unrelated guides.
    best_by_id: dict[str, dict[str, str | None]] = {}
    def relevance(guide: dict[str, str | None]) -> int:
        hero_text = re.sub(r"[^a-z0-9]", "", str(guide["hero"]).lower())
        title = re.sub(r"[^a-z0-9]", "", str(guide["title"]).lower())
        description = re.sub(r"[^a-z0-9]", "", str(guide["desc"]).lower())
        return (100 if hero_text and hero_text in title else 0) + (10 if hero_text and hero_text in description else 0)

    for guide in (item for hero in heroes for item in collected.get(hero, [])):
        guide_id = str(guide["id"])
        current = best_by_id.get(guide_id)
        if current is None or relevance(guide) > relevance(current):
            best_by_id[guide_id] = guide
    guides = list(best_by_id.values())
    guides.sort(key=lambda guide: int(guide["id"]), reverse=True)
    missing = [hero for hero in heroes if not collected.get(hero)]
    payload = {
        "source": "Steam Community",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hero_count": len(heroes),
        "guide_count": len(guides),
        "missing_heroes": missing,
        "guides": guides,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(guides)} Steam Hero Builds to {OUTPUT}")
    if missing:
        print("No matching public Hero Builds found for: " + ", ".join(missing))


if __name__ == "__main__":
    main()
