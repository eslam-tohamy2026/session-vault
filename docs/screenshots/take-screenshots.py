"""Take the README screenshots with headless Chromium (Playwright).

Usage (from the repository root):
    python docs/screenshots/take-screenshots.py

Requires Playwright + Chromium, e.g.:
    pip install playwright && python -m playwright install chromium

The manager shots render the shipped manager page in preview mode
(sample sessions); the popup shot renders the shipped popup markup
with a stubbed chrome API, since the popup only talks to the
extension through chrome.runtime.sendMessage. Re-run after any UI
change and LOOK at the images before committing them.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "screenshots"

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    page.goto((ROOT / "manager" / "index.html").as_uri())
    page.wait_for_timeout(600)
    page.screenshot(path=OUT / "manager-library.png")
    page.close()
    pop = b.new_page(viewport={"width": 360, "height": 560}, device_scale_factor=2)
    pop.add_init_script("""
      window.chrome = {
        runtime: {
          sendMessage: (msg, cb) => {
            if (msg.type === 'getLastAutosave') cb({ at: Date.now() - 120000 });
            else cb({ integrity: { status: 'ok', checkedAt: Date.now(), message: 'All copies verified' } });
          },
          getURL: (p) => p
        },
        tabs: { create: () => {} }
      };
    """)
    pop.goto((ROOT / "popup" / "popup.html").as_uri())
    pop.wait_for_timeout(400)
    pop.screenshot(path=OUT / "popup.png")
    pop.close()
    b.close()
print("wrote", OUT / "manager-library.png", "and", OUT / "popup.png")
