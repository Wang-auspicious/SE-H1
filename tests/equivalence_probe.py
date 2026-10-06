"""Differential probe: upstream viewer.js vs the TypeScript build.

Both pages load the *same* studio shell, the same shadow-root template and the
same model. The only difference is which viewer.js answers the request. Anything
that differs in the rendered tree is a porting bug, not a design choice.

Run:  python tests/equivalence_probe.py
Needs the dev server up on 8768 and the Playwright chromium build.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / "vendor" / "limen" / "viewer.js"
BUILD = ROOT / "viewer" / "viewer.js"
URL = "http://127.0.0.1:8768/"

# Properties that decide what the map looks like. Geometry is compared
# separately, as normalised rectangles.
STYLE_PROPS = [
    "display", "position", "left", "top", "width", "height",
    "fontSize", "fontFamily", "fontWeight", "fontStyle", "lineHeight",
    "color", "backgroundColor", "backgroundImage",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopColor", "borderStyle", "borderRadius",
    "padding", "margin", "gap", "opacity", "transform", "transformOrigin",
    "letterSpacing", "textTransform", "whiteSpace", "overflow",
    "textOverflow", "visibility", "zIndex", "boxShadow",
    "stroke", "strokeWidth", "strokeDasharray", "fill", "fillOpacity",
    "flexDirection", "alignItems", "justifyContent", "textAlign",
]

SNAPSHOT_JS = """
(props) => {
  const host = document.getElementById('picture-host');
  const rootEl = host && host.shadowRoot;
  if (!rootEl) return { error: 'no shadow root' };
  const hostRect = host.getBoundingClientRect();
  const out = [];
  const round = (v) => Math.round(v * 100) / 100;
  const cls = (el) =>
    el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '');
  const walk = (parent, path) => {
    const kids = parent.children;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const p = path + '/' + i;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const attrs = [];
      for (const a of el.attributes) attrs.push(a.name + '=' + a.value);
      attrs.sort();
      out.push({
        p: p,
        tag: el.tagName,
        cls: cls(el),
        attrs: attrs.join(' '),
        // Only leaf text: a parent's textContent is the concatenation of its
        // children's, so comparing it too would report every change twice.
        text: el.children.length === 0 ? (el.textContent || '').slice(0, 200) : '',
        rect: [
          round(r.left - hostRect.left), round(r.top - hostRect.top),
          round(r.width), round(r.height),
        ],
        style: props.map((k) => k + '=' + cs[k]).join(';'),
      });
      walk(el, p);
    }
  };
  walk(rootEl, '');
  return { host: [round(hostRect.width), round(hostRect.height)], nodes: out };
}
"""


def snapshot(page):
    return page.evaluate(SNAPSHOT_JS, STYLE_PROPS)


def collect(playwright, chromium_path, use_build, drill=None):
    browser = playwright.chromium.launch(executable_path=chromium_path)
    try:
        ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
        page = ctx.new_page()
        if not use_build:
            # The page ships the TypeScript build; this run swaps the upstream
            # copy in behind it, so the two renders can be compared.
            page.route(
                "**/viewer/viewer.js",
                lambda route: route.fulfill(
                    path=str(UPSTREAM), content_type="application/javascript"
                ),
            )
        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(2000)
        if drill:
            page.locator(".block", has_text=drill).first.click()
            page.wait_for_timeout(1200)
        return snapshot(page)
    finally:
        browser.close()


def diff(a, b, limit=25):
    diffs = []
    an, bn = a.get("nodes", []), b.get("nodes", [])
    if len(an) != len(bn):
        diffs.append(f"NODE COUNT: upstream={len(an)} build={len(bn)}")
    for i in range(min(len(an), len(bn))):
        x, y = an[i], bn[i]
        for key in ("tag", "cls", "attrs", "text"):
            if x[key] != y[key]:
                diffs.append(f"[{i}] {x['p']} {key}: {x[key]!r} != {y[key]!r}")
        if x["rect"] != y["rect"]:
            diffs.append(f"[{i}] {x['p']} rect: {x['rect']} != {y['rect']}")
        if x["style"] != y["style"]:
            xs, ys = x["style"].split(";"), y["style"].split(";")
            bad = [f"{p} != {q}" for p, q in zip(xs, ys) if p != q]
            diffs.append(f"[{i}] {x['p']} style: {'; '.join(bad)}")
    return diffs[:limit], len(diffs)


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed")
        return 1

    exe = Path(r"C:\Users\zjz65\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe")
    if not exe.exists():
        print(f"chromium not found at {exe}")
        return 1

    failed = False
    with sync_playwright() as p:
        for label, drill in (("root level", None), ("drilled into studio.js", "studio.js")):
            up = collect(p, str(exe), False, drill)
            port = collect(p, str(exe), True, drill)
            if "error" in up or "error" in port:
                print(f"{label}: {up.get('error') or port.get('error')}")
                failed = True
                continue
            d, total = diff(up, port)
            status = "IDENTICAL" if total == 0 else f"{total} DIFFERENCES"
            print(f"--- {label}: {len(up['nodes'])} elements -> {status}")
            for line in d:
                print("   ", line)
            if total:
                failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
