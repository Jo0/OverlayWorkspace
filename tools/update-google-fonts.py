#!/usr/bin/env python3
"""Regenerates data/google-fonts.json, the catalog behind the web font picker.

    python tools/update-google-fonts.py [metadata.json]

Without an argument it downloads Google Fonts' public metadata
(https://fonts.google.com/metadata/fonts, no API key needed). The output keeps
what the picker needs, most popular first:

    { "f": family, "c": category, "w": [upright weights], "i": has italics }

Only open-source families with a Latin subset are kept. "w" matters: the
Google Fonts CSS API rejects a request for a weight a family doesn't have.
"""
import json, os, sys, urllib.request

URL = "https://fonts.google.com/metadata/fonts"
CATEGORIES = {"Sans Serif": "sans", "Serif": "serif", "Display": "display", "Handwriting": "handwriting", "Monospace": "mono"}


def load(path):
    if path:
        text = open(path, encoding="utf8").read()
    else:
        req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
        text = urllib.request.urlopen(req, timeout=60).read().decode("utf8")
    return json.loads(text[text.index("{"):])  # older responses start with )]}'


def main():
    meta = load(sys.argv[1] if len(sys.argv) > 1 else None)
    out = []
    for fam in meta["familyMetadataList"]:
        if not fam.get("isOpenSource", True) or "latin" not in fam.get("subsets", []):
            continue
        # 100-900 only: a few variable fonts also list 1 and 1000, useless on video.
        weights = sorted({int(k) for k in fam["fonts"] if k.isdigit() and 100 <= int(k) <= 900})
        if not weights:
            continue
        out.append({
            "f": fam["family"],
            "c": CATEGORIES.get(fam.get("category"), "other"),
            "w": weights,
            "i": any(k.endswith("i") for k in fam["fonts"]),
            "_p": fam.get("popularity", 99999),
        })
    out.sort(key=lambda e: (e["_p"], e["f"]))
    for e in out:
        del e["_p"]
    dest = os.path.join(os.path.dirname(__file__), "..", "data", "google-fonts.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf8", newline="\n") as f:
        f.write("[\n" + ",\n".join(json.dumps(e, separators=(",", ":")) for e in out) + "\n]\n")
    print(f"{len(out)} families -> {os.path.normpath(dest)}")


if __name__ == "__main__":
    main()
