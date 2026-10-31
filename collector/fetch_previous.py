"""Download the JSON the live site is currently serving, so the collector can
compare against it (rolling 7-day archive, story ids, trending baseline).

On the very first run there is no live site yet: that is fine, we just say so
and the collector starts from scratch. This script never fails the workflow.

    python collector/fetch_previous.py --base-url https://you.github.io/broadsheet/ --out previous
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

FILES = ("archive.json", "status.json", "trending.json")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True, help="address of the live site")
    parser.add_argument("--out", required=True, help="folder to save the files in")
    args = parser.parse_args()

    base = args.base_url.strip()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if not base:
        print("No site address known yet; starting from scratch.")
        return 0
    if not base.endswith("/"):
        base += "/"

    for name in FILES:
        url = f"{base}data/{name}?nocache={int(time.time())}"
        request = urllib.request.Request(url, headers={"User-Agent": "Broadsheet/1.0 (previous-run download)"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
            json.loads(body.decode("utf-8"))  # make sure it is valid before keeping it
            (out / name).write_bytes(body)
            print(f"Downloaded previous {name} ({len(body) / 1024:.0f} KB)")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                print(f"No previous {name} on the live site (normal for the first run).")
            else:
                print(f"Could not download previous {name}: HTTP {exc.code}. Continuing without it.")
        except Exception as exc:  # noqa: BLE001
            print(f"Could not download previous {name}: {exc}. Continuing without it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
