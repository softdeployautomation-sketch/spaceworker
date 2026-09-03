"""
FastAPI WebSocket Server for Live Browser Automation
Runs Playwright automation, extracts leads from PDFs, and saves them.
"""
from __future__ import annotations

import asyncio
import json
import base64
import time
import io
import os
import sys
import subprocess
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional, Literal
from bs4 import BeautifulSoup
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from playwright.async_api import async_playwright, Page, Browser
from urllib.parse import quote_plus, urlparse, parse_qs, unquote
import httpx


def is_rdp_session() -> bool:
    """
    Detect if running in RDP (Remote Desktop Protocol) session.
    RDP sessions often lack GPU acceleration and proper display drivers,
    so we should use headless mode for browser automation.
    """
    if sys.platform != 'win32':
        return False
    
    # Check Windows environment variables that indicate RDP session
    session_name = os.environ.get('SESSIONNAME', '').upper()
    client_name = os.environ.get('CLIENTNAME', '')
    remote_session = os.environ.get('REMOTE_SESSION', '0')
    
    # RDP sessions typically have SESSIONNAME starting with 'RDP'
    if session_name.startswith('RDP'):
        return True
    
    # If CLIENTNAME is set, it's likely a remote session
    if client_name:
        return True
    
    # REMOTE_SESSION environment variable
    if remote_session == '1':
        return True
    
    # Check for TERM_PROGRAM (some RDP clients set this)
    if os.environ.get('TERM_PROGRAM', '').upper() in ['RDP', 'REMOTE']:
        return True
    
    return False


def _strip_trailing_filetype_pdf(raw: str) -> str:
    """Strip trailing filetype:pdf from queued strings so site: is not re-wrapped each variation."""
    t = (raw or "").strip()
    low = t.lower()
    for suf in (" filetype:pdf", " filetype: pdf"):
        if low.endswith(suf):
            return t[: -len(suf)].strip()
    return t


# DuckDuckGo HTML search rejects very long queries; nested (site:) bugs used to exceed this fast.
MAX_DDG_QUERY_CHARS = 420

_HTML_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _url_is_reddit_thread_like(href: str) -> bool:
    """Rough filter: Reddit post / short link, not the homepage."""
    if not href or not href.strip():
        return False
    try:
        h = href.strip()
        if h.startswith("//"):
            u = urlparse("https:" + h)
        elif h.startswith("http"):
            u = urlparse(h)
        else:
            u = urlparse("https://" + h.lstrip("/"))
        host = (u.netloc or "").lower()
        path = (u.path or "").lower()
        if host == "redd.it" or host.endswith(".redd.it"):
            return len(path) > 1
        if host == "reddit.com" or host.endswith(".reddit.com"):
            if "/comments/" in path:
                return True
            if path.startswith("/r/") and len(path) > 4:
                return True
        return False
    except Exception:
        return False


def _classify_ddg_serp_href(href: str, html_first_mode: bool) -> Optional[Literal["pdf", "html"]]:
    """How to handle a DuckDuckGo result URL. None = skip."""
    path_lower = (href.split("?")[0] if "?" in href else href).lower()
    if path_lower.endswith(".pdf"):
        return "pdf"
    if html_first_mode and _url_is_reddit_thread_like(href):
        return "html"
    return None


# Package root on path, then pdfplumber + extractors
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from worker.utils.pdf_logging import suppress_pdfminer_color_warnings

suppress_pdfminer_color_warnings()
import pdfplumber

from worker.extractors.email_extractor import extract_emails
from worker.extractors.name_extractor import extract_contact_names, extract_names_from_email
from worker.extractors.phone_extractor import extract_phones
# REMOVED for SpaceWorker Task 2: this worker is stateless per job (no DB writes
# of its own — see TASK_02_EXTRACTION_WORKER.md). The original save_search/save_leads
# calls further down this file need to be deleted, not just this import — search for
# their call sites and remove them as part of building the new POST /jobs API wrapper.
from worker.filters.email_domain_rules import (
    apply_site_restriction_to_query,
    filter_leads_by_email_domains,
    parse_email_domain_allowlist,
    prepare_site_restriction_for_automation,
    site_restriction_targets_only_pdf_rare_hosts,
)

app = FastAPI()


@app.on_event("startup")
def _run_db_retention_on_startup():
    """Prune old searches/leads (30d default) — throttled so multiple workers don't hammer DB."""
    try:
        from app.database.db import maybe_prune_stale_searches

        r = maybe_prune_stale_searches(interval_hours=24.0)
        if r and not r.get("skipped") and (
            r.get("searches_deleted", 0) or r.get("leads_deleted", 0)
        ):
            print(
                f"[DB] Retention prune removed {r.get('searches_deleted', 0)} session(s), "
                f"{r.get('leads_deleted', 0)} lead row(s)",
                file=sys.stderr,
                flush=True,
            )
    except Exception as e:
        print(f"[DB] Retention prune skipped: {e}", file=sys.stderr, flush=True)

# CORS for Streamlit
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AutomationManager:
    """Manages Playwright browser automation and WebSocket connections."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.browser: Optional[Browser] = None
        self._persistent_context = None  # For macOS launch_persistent_context
        self._context = None  # BrowserContext from new_context (must close or window can linger)
        self.page: Optional[Page] = None
        self.playwright = None
        self.is_running = False
        self.stop_flag = False
        self.task = None  # asyncio Task for run_automation — stored so Stop can cancel it
        self.last_screenshot_time = 0
        self.screenshot_throttle = 1.0  # Max 1 screenshot per second
        self.send_screenshots = True  # UI can disable to save bandwidth
        self.all_leads_buffer = []  # Buffer to save on disconnect
        self.current_session_id = None  # Track current search session

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def shutdown_playwright(self) -> list[str]:
        """
        Close page, browser context, browser, and Playwright so the OS window exits.
        Safe to call multiple times (e.g. Stop button + run_automation finally).
        """
        warnings: list[str] = []
        try:
            if self.page:
                try:
                    await self.page.close()
                except Exception as e:
                    warnings.append(f"page:{str(e)[:40]}")
                self.page = None
            if getattr(self, "_context", None):
                try:
                    await self._context.close()
                except Exception as e:
                    warnings.append(f"context:{str(e)[:40]}")
                self._context = None
            if getattr(self, "_persistent_context", None):
                try:
                    await self._persistent_context.close()
                except Exception as e:
                    warnings.append(f"persistent:{str(e)[:40]}")
                self._persistent_context = None
            if self.browser:
                try:
                    await self.browser.close()
                except Exception as e:
                    warnings.append(f"browser:{str(e)[:40]}")
                self.browser = None
            if self.playwright:
                try:
                    await self.playwright.stop()
                except Exception as e:
                    warnings.append(f"playwright:{str(e)[:40]}")
                self.playwright = None
        except Exception as e:
            warnings.append(f"shutdown:{str(e)[:50]}")
        return warnings

    async def broadcast(self, message: dict):
        """Send message to all connected clients."""
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)

    def _schedule_browser_closed_complete(self):
        """Called on event loop thread when browser disconnects; schedules async broadcast."""
        if getattr(self, "_browser_closed_completion_sent", False):
            return
        asyncio.ensure_future(self._broadcast_browser_closed())

    async def _broadcast_browser_closed(self):
        """Save all leads and send 'complete' to UI when user closes the browser."""
        if getattr(self, "_browser_closed_completion_sent", False):
            return
        self._browser_closed_completion_sent = True
        try:
            await self.broadcast({"type": "status", "message": "🔚 Browser closed by user - saving leads..."})
            # CRITICAL: Save all accumulated leads before sending complete (replace=True = overwrite with full buffer)
            if self.all_leads_buffer and self.current_session_id:
                try:
                    save_leads(self.current_session_id, self.all_leads_buffer, replace=True)
                    await self.broadcast({"type": "status", "message": f"💾 Saved {len(self.all_leads_buffer)} leads to database"})
                except Exception as e:
                    await self.broadcast({"type": "status", "message": f"⚠️ Save error: {str(e)[:50]}"})
            await self.broadcast({"type": "complete", "data": list(self.all_leads_buffer)})
        except Exception:
            pass

    async def take_screenshot(self, force: bool = False) -> str:
        """Take screenshot and return base64 string (throttled).
        Returns '' immediately when send_screenshots is False (saves CPU + bandwidth)."""
        if not self.send_screenshots:
            return ""
        if not self.page:
            return ""

        # Throttle screenshots to prevent spam
        current_time = time.time()
        if not force and (current_time - self.last_screenshot_time) < self.screenshot_throttle:
            return ""

        try:
            screenshot_bytes = await self.page.screenshot(full_page=False, timeout=5000)
            self.last_screenshot_time = current_time
            return base64.b64encode(screenshot_bytes).decode()
        except Exception:
            return ""

    async def extract_from_pdf(self, pdf_url: str, title: str, display_link: str) -> List[Dict]:
        """Download PDF, extract text, and extract leads."""
        leads = []
        try:
            await self.broadcast({
                "type": "status",
                "message": f"  📥 Downloading PDF: {title[:50]}...",
            })

            # Download PDF with better error handling
            pdf_bytes = None
            try:
                async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                    response = await client.get(pdf_url)
                    if response.status_code != 200:
                        await self.broadcast({
                            "type": "status",
                            "message": f"  ❌ Failed to download PDF (HTTP {response.status_code})",
                        })
                        return leads
                    pdf_bytes = io.BytesIO(response.content)
            except httpx.TimeoutException:
                await self.broadcast({
                    "type": "status",
                    "message": f"  ❌ PDF download timeout",
                })
                return leads
            except Exception as e:
                await self.broadcast({
                    "type": "status",
                    "message": f"  ❌ Download error: {str(e)[:50]}",
                })
                return leads

            if not pdf_bytes:
                return leads
                
            # Extract text from PDF
            text_parts = []
            try:
                with pdfplumber.open(pdf_bytes) as pdf:
                    total_pages = len(pdf.pages)
                    await self.broadcast({
                        "type": "status",
                        "message": f"  📖 PDF has {total_pages} page(s), extracting text...",
                    })
                    
                    # Extract from ALL pages (not just first page)
                    for page_num, page in enumerate(pdf.pages[:100]):  # Max 100 pages
                        try:
                            page_text = page.extract_text()
                            if page_text:
                                text_parts.append(page_text)
                                await self.broadcast({
                                    "type": "status",
                                    "message": f"  📄 Extracted text from page {page_num + 1}/{total_pages} ({len(page_text)} chars)",
                                })
                        except Exception as e:
                            await self.broadcast({
                                "type": "status",
                                "message": f"  ⚠️ Page {page_num + 1} extraction error: {str(e)[:40]}",
                            })
                            continue
            except Exception as e:
                await self.broadcast({
                    "type": "status",
                    "message": f"  ❌ PDF parsing error: {str(e)[:60]}",
                })
                return leads

            pdf_text = "\n".join(text_parts)
            
            if not pdf_text or len(pdf_text.strip()) < 10:
                await self.broadcast({
                    "type": "status",
                    "message": f"  ⚠️ No text extracted from PDF (might be image-based/scanned)",
                })
                return leads

            await self.broadcast({
                "type": "status",
                "message": f"  ✅ Extracted {len(pdf_text)} chars from PDF",
            })

            # Extract ONLY: name, phone, email (as requested)
            await self.broadcast({
                "type": "status",
                "message": f"  🔍 Searching for emails, phones, names...",
            })
            
            emails = extract_emails(pdf_text, "")
            phones = extract_phones(pdf_text, "")
            names = extract_contact_names(pdf_text)

            await self.broadcast({
                "type": "status",
                "message": f"  📊 Found: {len(emails)} emails, {len(phones)} phones, {len(names)} names",
            })

            # Derive names from emails if no names found
            if emails and not names:
                for email in emails:
                    derived = extract_names_from_email(email)
                    if derived:
                        names.append(derived)

            # Create lead entries - ONLY name, phone, email
            if emails:
                # Create one lead per email
                for j, email in enumerate(emails):
                    cn = names[j] if j < len(names) else (names[0] if names else "")
                    ph = phones[j] if j < len(phones) else (phones[0] if phones else "")
                    leads.append({
                        "email": email,
                        "phone": ph,
                        "contact_name": cn,
                        # Minimal fields for database compatibility
                        "business_name": "",
                        "website": "",
                        "source_url": pdf_url,
                        "snippet": "",
                    })
                await self.broadcast({
                    "type": "status",
                    "message": f"  ✅ Created {len(leads)} lead(s) from PDF",
                })
            elif phones or names:
                # Include even without email (at least phone or name)
                leads.append({
                    "email": "",
                    "phone": phones[0] if phones else "",
                    "contact_name": names[0] if names else "",
                    "business_name": "",
                    "website": "",
                    "source_url": pdf_url,
                    "snippet": "",
                })
                await self.broadcast({
                    "type": "status",
                    "message": f"  ✅ Created 1 lead (phone/name only) from PDF",
                })
            else:
                await self.broadcast({
                    "type": "status",
                    "message": f"  ⚠️ No emails/phones/names found in PDF text",
                })
                # Debug: show first 200 chars of text
                await self.broadcast({
                    "type": "status",
                    "message": f"  🔍 PDF text sample: {pdf_text[:200]}...",
                })

        except Exception as e:
            await self.broadcast({
                "type": "status",
                "message": f"  ❌ PDF extraction error: {str(e)[:60]}",
            })

        return leads

    async def extract_from_html(self, page_url: str, title: str, display_link: str) -> List[Dict]:
        """Download HTML (e.g. Reddit thread), visible text, same lead fields as PDF path."""
        leads: List[Dict] = []
        try:
            await self.broadcast({
                "type": "status",
                "message": f"  📥 Fetching page: {title[:50]}...",
            })
            html_text = ""
            try:
                async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                    response = await client.get(page_url, headers=_HTML_FETCH_HEADERS)
                    if response.status_code != 200:
                        await self.broadcast({
                            "type": "status",
                            "message": f"  ❌ Page HTTP {response.status_code}",
                        })
                        return leads
                    raw = response.text or ""
                    soup = BeautifulSoup(raw, "lxml")
                    for tag in soup(["script", "style", "noscript"]):
                        tag.decompose()
                    html_text = soup.get_text(separator="\n", strip=True)
            except httpx.TimeoutException:
                await self.broadcast({"type": "status", "message": "  ❌ Page download timeout"})
                return leads
            except Exception as e:
                await self.broadcast({
                    "type": "status",
                    "message": f"  ❌ Page fetch error: {str(e)[:50]}",
                })
                return leads

            if not html_text or len(html_text.strip()) < 10:
                await self.broadcast({
                    "type": "status",
                    "message": "  ⚠️ No usable text on page (blocked, login wall, or empty)",
                })
                return leads

            await self.broadcast({
                "type": "status",
                "message": f"  ✅ Extracted {len(html_text)} chars from page",
            })
            await self.broadcast({
                "type": "status",
                "message": "  🔍 Searching for emails, phones, names...",
            })

            emails = extract_emails(html_text, "")
            phones = extract_phones(html_text, "")
            names = extract_contact_names(html_text)

            await self.broadcast({
                "type": "status",
                "message": f"  📊 Found: {len(emails)} emails, {len(phones)} phones, {len(names)} names",
            })

            if emails and not names:
                for email in emails:
                    derived = extract_names_from_email(email)
                    if derived:
                        names.append(derived)

            if emails:
                for j, email in enumerate(emails):
                    cn = names[j] if j < len(names) else (names[0] if names else "")
                    ph = phones[j] if j < len(phones) else (phones[0] if phones else "")
                    leads.append({
                        "email": email,
                        "phone": ph,
                        "contact_name": cn,
                        "business_name": "",
                        "website": "",
                        "source_url": page_url,
                        "snippet": "",
                    })
                await self.broadcast({
                    "type": "status",
                    "message": f"  ✅ Created {len(leads)} lead(s) from page",
                })
            elif phones or names:
                leads.append({
                    "email": "",
                    "phone": phones[0] if phones else "",
                    "contact_name": names[0] if names else "",
                    "business_name": "",
                    "website": "",
                    "source_url": page_url,
                    "snippet": "",
                })
                await self.broadcast({
                    "type": "status",
                    "message": "  ✅ Created 1 lead (phone/name only) from page",
                })
            else:
                await self.broadcast({
                    "type": "status",
                    "message": "  ⚠️ No emails/phones/names in page text",
                })
        except Exception as e:
            await self.broadcast({
                "type": "status",
                "message": f"  ❌ HTML extraction error: {str(e)[:60]}",
            })
        return leads

    async def run_automation(
        self,
        queries: List[str],
        max_pages: int = 10,
        delay_between_pages: float = 3.0,
        delay_between_actions: float = 1.0,
        target_leads: int = 0,  # Target lead count (0 = no limit)
        search_engine: str = "duckduckgo",  # "duckduckgo" avoids Google CAPTCHA
        headless: bool = False,  # False = visible browser (from Settings)
        reload_between_queries: bool = False,  # Fresh browser between each batch query
        email_domain_allowlist: str = "",  # Keep only leads whose email matches (see filters/email_domain_rules)
        search_site_domains: str = "",  # Append site: restrictions to each search query
    ):
        """Run browser automation loop through multiple queries."""
        self.is_running = True
        self.stop_flag = False
        all_leads = []
        master_search_id = None  # One DB session for whole run (set after queue init)
        total_leads_extracted = 0  # Track total leads for real-time updates
        self._event_loop = asyncio.get_running_loop()
        self._browser_closed_completion_sent = False

        await self.broadcast({"type": "status", "message": "🚀 Automation starting..."})
        try:
            self.playwright = await async_playwright().start()

            # RDP = force headless. Otherwise respect user's headless setting (including on macOS).
            # Headless works everywhere (Cursor, Terminal, CI) and still logs activity + extracts emails.
            use_headless = is_rdp_session() or headless
            print(f"[Automation] headless={headless} (from UI), use_headless={use_headless}", file=sys.stderr, flush=True)

            if is_rdp_session():
                await self.broadcast({"type": "status", "message": "🔍 RDP detected - headless mode"})
            elif use_headless:
                await self.broadcast({"type": "status", "message": "🔍 Headless mode"})
            else:
                await self.broadcast({"type": "status", "message": "🌐 Launching visible browser..."})

            def on_browser_disconnected():
                self.stop_flag = True
                self.is_running = False
                try:
                    loop = getattr(self, "_event_loop", None)
                    if loop and not loop.is_closed():
                        loop.call_soon_thread_safe(self._schedule_browser_closed_complete)
                except Exception:
                    pass

            # On macOS visible mode: use system Chrome (channel=chrome) - more reliable window display
            launch_opts = dict(
                headless=use_headless,
                slow_mo=int(delay_between_actions * 1000),
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-web-security",
                    "--disable-features=IsolateOrigins,site-per-process",
                ],
            )
            if not use_headless:
                launch_opts["args"].append("--start-maximized")  # Make automation window obvious
            # Chrome 112+ "new" headless = same engine as headed (better DuckDuckGo/Google)
            if use_headless:
                launch_opts["args"].append("--headless=new")
                launch_opts["ignore_default_args"] = ["--headless"]  # Use our --headless=new instead
                # Use system Chrome for headless on macOS - better compatibility than bundled Chromium
                if sys.platform == "darwin":
                    launch_opts["channel"] = "chrome"
            else:
                # Visible mode: start maximized; disable GPU to avoid macOS hangs (browser opens but stays blank)
                launch_opts["args"].extend(["--start-maximized", "--window-position=0,0"])
                if sys.platform == "darwin":
                    launch_opts["args"].extend(["--disable-gpu", "--disable-software-rasterizer"])
            # Visible mode: use PLAIN Chromium (not system Chrome) - diagnostic showed it pops up reliably
            try:
                print(f"[Automation] Launching browser: headless={use_headless}", file=sys.stderr, flush=True)
                self.browser = await self.playwright.chromium.launch(**launch_opts)
                print(f"[Automation] Browser launched successfully", flush=True)
            except Exception as e:
                err_str = str(e).lower()
                # ENOENT / spawn = bundled Chromium missing (common with PyInstaller exe)
                if "enoent" in err_str or "spawn" in err_str or "failed to launch" in err_str:
                    await self.broadcast({"type": "status", "message": "⚠️ Bundled browser not found, trying system Chrome..."})
                    try:
                        launch_opts["channel"] = "chrome"
                        self.browser = await self.playwright.chromium.launch(**launch_opts)
                        print(f"[Automation] Browser launched via system Chrome", flush=True)
                    except Exception as e2:
                        await self.broadcast({
                            "type": "status",
                            "message": "❌ Install Chrome or run: pip install playwright && playwright install chromium",
                        })
                        raise
                elif "channel" in launch_opts:
                    del launch_opts["channel"]
                    await self.broadcast({"type": "status", "message": "⚠️ Chrome not found, using Chromium"})
                    self.browser = await self.playwright.chromium.launch(**launch_opts)
                else:
                    raise
            self.browser.on("disconnected", on_browser_disconnected)

            print("[Automation] Creating browser context...", file=sys.stderr, flush=True)
            context_opts = dict(
                viewport={"width": 1920, "height": 1080},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                locale="en-US",
                timezone_id="America/New_York",
                permissions=["geolocation"],
                geolocation={"latitude": 40.7128, "longitude": -74.0060},
                color_scheme="light",
            )
            context = await self.browser.new_context(**context_opts)
            self._context_opts = context_opts  # For reload-between-batches
            self._context = context

            await context.set_extra_http_headers({
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "DNT": "1",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1",
            })
            print("[Automation] Context created, creating page...", file=sys.stderr, flush=True)

            self.page = await context.new_page()
            self.page.on("close", on_browser_disconnected)
            print("[Automation] Page created, bringing to front...", file=sys.stderr, flush=True)
            try:
                await self.page.bring_to_front()
            except Exception:
                pass
            # macOS: try to bring browser window to front (Chrome/Chromium - must match channel used above)
            if sys.platform == "darwin" and not use_headless:
                try:
                    for app_name in ["Google Chrome", "Chromium", "Chrome"]:
                        subprocess.run(
                            ["osascript", "-e", f'tell application "{app_name}" to activate'],
                            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2
                        )
                        break  # Try first available
                except Exception:
                    pass

            # Remove webdriver property
            print("[Automation] Injecting anti-detection scripts...", file=sys.stderr, flush=True)
            await self.page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                
                // Override plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5]
                });
                
                // Override languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
                
                // Override permissions
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({ state: Notification.permission }) :
                        originalQuery(parameters)
                );
            """)

            print("[Automation] Setup complete, starting query loop...", file=sys.stderr, flush=True)
            engine_msg = "🦆 DuckDuckGo (no CAPTCHA)" if search_engine == "duckduckgo" else "🔍 Google (may show CAPTCHA)"
            await self.broadcast({
                "type": "status",
                "message": f"🚀 Starting automation - {len(queries)} queries | Search engine: {engine_msg}",
            })

            session_start_time = datetime.now()
            self.all_leads_buffer = []  # Reset buffer

            email_rules = parse_email_domain_allowlist(email_domain_allowlist)
            site_clause, site_skipped_portals, site_accepted_domains = (
                prepare_site_restriction_for_automation(search_site_domains)
            )
            ddg_html_first_mode = (
                search_engine == "duckduckgo"
                and site_restriction_targets_only_pdf_rare_hosts(site_accepted_domains)
            )
            if ddg_html_first_mode:
                await self.broadcast({
                    "type": "status",
                    "message": (
                        "📌 **Reddit / thread mode:** site list is PDF-rare only (e.g. `reddit.com`). "
                        "Skipping automatic `filetype:pdf` and parsing **HTML** result links. "
                        "Mixed site lists (e.g. Reddit + `.gov`) still use PDF mode for all hosts."
                    ),
                })
            if site_skipped_portals:
                await self.broadcast({
                    "type": "status",
                    "message": (
                        "ℹ️ **Not using site:** for "
                        + ", ".join(f"`{d}`" for d in site_skipped_portals)
                        + " — that would only show pages **hosted on** those sites, not “search with Google/Facebook”. "
                        "Leave this box empty for a normal web search, or list real PDF hosts (e.g. `state.gov`, a university domain)."
                    ),
                })
            if site_clause:
                await self.broadcast({
                    "type": "status",
                    "message": f"🔒 **Site restriction** added to every search: `{site_clause[:140]}{'…' if len(site_clause) > 140 else ''}`",
                })
            if not email_rules.is_empty():
                await self.broadcast({
                    "type": "status",
                    "message": (
                        f"🎯 **Email domain filter** on — keeping only addresses matching "
                        f"{len(email_rules.exact_domains)} domain(s) and {len(email_rules.suffixes)} suffix rule(s); "
                        f"others are dropped before save."
                    ),
                })

            # Query queue: extend with extra phrases when DDG yields few PDFs / pages end — scales toward 100k+ targets
            DDG_QUERY_VARIATIONS = [
                " list", " directory", " roster", " members", " membership",
                " board of directors", " committee", " officers", " chapter",
                " email directory", " staff directory", " contact list",
                " member directory", " phone directory", " directory contact",
                " annual report", " meeting minutes", " registration form",
                " volunteers", " club", " association", " foundation",
                " nonprofit", " pdf contact", " public records",
                " state filing", " tax exempt", " organization",
                " leadership", " team", " contacts page",
                " site:org", " filetype:pdf intext:email",
            ]
            if ddg_html_first_mode:
                DDG_QUERY_VARIATIONS = [
                    v for v in DDG_QUERY_VARIATIONS if "filetype:" not in v.lower()
                ]
            query_queue = list(queries)
            initial_queries_frozen = frozenset((q or "").strip() for q in queries if (q or "").strip())
            variation_idx = 0
            query_idx = 0

            # One DB search row per automation *run* (single Start): all query variants + auto-variations
            # share the same session so Saved Leads doesn't show 6 fragments for one logical job.
            q_parts = [(q or "").strip() for q in queries if (q or "").strip()]
            if not q_parts:
                session_label = "(no query)"
            elif len(q_parts) == 1:
                session_label = q_parts[0]
            else:
                session_label = q_parts[0][:120] + f" (+{len(q_parts) - 1} batch lines)"
            try:
                master_search_id = save_search(session_label, num_results=0)
                self.current_session_id = master_search_id
                await self.broadcast({
                    "type": "status",
                    "message": f"💾 Session #{master_search_id} — all query passes in this run save here (one row)",
                })
            except Exception as e:
                await self.broadcast({
                    "type": "status",
                    "message": f"⚠️ Database error (session): {str(e)[:50]}. Leads may not persist.",
                })
                self.current_session_id = None

            # Init script for anti-detection (reused when reloading context)
            _init_script = """
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5]
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({ state: Notification.permission }) :
                        originalQuery(parameters)
                );
            """

            while query_queue and not self.stop_flag:
                query = (query_queue.pop(0) or "").strip()
                # Apply site: only to keyword part — queue must never contain a pre-wrapped "(...) site:" string
                # or each auto-variation would wrap again (broken parens + DDG "query too long").
                query_keywords = _strip_trailing_filetype_pdf(query)
                effective_query = apply_site_restriction_to_query(query_keywords, site_clause)
                query_idx += 1
                if query in initial_queries_frozen:
                    variation_idx = 0
                if self.stop_flag:
                    await self.broadcast({"type": "status", "message": "🛑 Stopped by user"})
                    break

                # Reload browser between batches (fresh context for each query after the first)
                reload_ok = True
                if reload_between_queries and query_idx > 1:
                    await self.broadcast({
                        "type": "status",
                        "message": "🔄 Reloading browser for next batch (save → fresh start)...",
                    })
                    for reload_attempt in range(1, 4):
                        try:
                            if self.page:
                                await self.page.close()
                                self.page = None
                            if getattr(self, "_context", None):
                                await self._context.close()
                                self._context = None
                        except Exception as e:
                            await self.broadcast({"type": "status", "message": f"⚠️ Close error: {str(e)[:40]}"})
                        await asyncio.sleep(2)
                        try:
                            self._context = await self.browser.new_context(**self._context_opts)
                            await self._context.set_extra_http_headers({
                                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                                "Accept-Language": "en-US,en;q=0.9",
                                "Accept-Encoding": "gzip, deflate, br",
                                "DNT": "1",
                                "Connection": "keep-alive",
                                "Upgrade-Insecure-Requests": "1",
                            })
                            self.page = await self._context.new_page()
                            self.page.on("close", on_browser_disconnected)
                            await self.page.add_init_script(_init_script)
                            await self.broadcast({"type": "status", "message": "✅ Fresh browser ready for next batch"})
                            reload_ok = True
                            break
                        except Exception as e:
                            await self.broadcast({"type": "status", "message": f"❌ Reload attempt {reload_attempt}/3 failed: {str(e)[:50]}"})
                            reload_ok = False
                            if reload_attempt < 3:
                                await asyncio.sleep(3)
                    if not reload_ok:
                        await self.broadcast({"type": "status", "message": "⚠️ Reload failed - retrying context creation..."})
                        try:
                            self._context = await self.browser.new_context(**self._context_opts)
                            await self._context.set_extra_http_headers({
                                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                                "Accept-Language": "en-US,en;q=0.9",
                                "Accept-Encoding": "gzip, deflate, br",
                                "DNT": "1",
                                "Connection": "keep-alive",
                                "Upgrade-Insecure-Requests": "1",
                            })
                            self.page = await self._context.new_page()
                            self.page.on("close", on_browser_disconnected)
                            await self.page.add_init_script(_init_script)
                            reload_ok = True
                            await self.broadcast({"type": "status", "message": "✅ Context recovered, continuing..."})
                        except Exception as e2:
                            await self.broadcast({
                                "type": "status",
                                "message": f"❌ Cannot recover after reload failure. Try disabling 'Reload between batches' in Batch Mode. Error: {str(e2)[:60]}",
                            })
                            self.stop_flag = True
                            break
                    await asyncio.sleep(5)  # Pause to avoid looking robotic

                try:
                    total_queued = query_idx + len(query_queue)
                    q_preview = effective_query if len(effective_query) <= 72 else effective_query[:69] + "..."
                    await self.broadcast({
                        "type": "query_progress",
                        "current": query_idx,
                        "total": total_queued,
                        "current_query": effective_query[:80],
                    })
                    await self.broadcast({
                        "type": "status",
                        "message": f"--- Query {query_idx} (total in queue: {total_queued}): \"{q_preview}\" ---",
                    })

                    # Reuse the same DB session for every queue item (variants included)
                    search_id = master_search_id
                    if master_search_id:
                        await self.broadcast({
                            "type": "status",
                            "message": f"📎 Pass #{query_idx} → session #{master_search_id} (cumulative save)",
                        })

                    query_leads = []

                    # ─── DuckDuckGo flow (no CAPTCHA) ─────────────────────────────────────────
                    if search_engine == "duckduckgo":
                        # PDF runs: filetype:pdf improves hits. Reddit-only site: forces empty SERPs + we need HTML URLs.
                        q = effective_query.strip()
                        if not ddg_html_first_mode:
                            if "filetype:pdf" not in q.lower() and "filetype: pdf" not in q.lower():
                                q = f"{q} filetype:pdf"
                        if len(q) > MAX_DDG_QUERY_CHARS:
                            await self.broadcast({
                                "type": "status",
                                "message": (
                                    f"⚠️ Query was {len(q)} chars; DuckDuckGo rejects very long strings. "
                                    f"Truncating to {MAX_DDG_QUERY_CHARS} chars — narrow keywords or fewer site: domains."
                                ),
                            })
                            q = q[:MAX_DDG_QUERY_CHARS].strip()
                        ddg_url = f"https://html.duckduckgo.com/html/?q={quote_plus(q)}"
                        ddg_q_sent = q  # what we actually searched (for lead metadata)
                        await self.broadcast({"type": "status", "message": f"🌐 [DuckDuckGo] Opening... (no CAPTCHA)"})
                        await self.broadcast({"type": "status", "message": f"  🔍 Query: {q[:60]}..."})
                        processed_urls = set()
                        pdf_count = 0
                        no_more_ddg_pages = False
                        ddg_page = 0
                        ddg_flow_error = False
                        try:
                            for ddg_page in range(1, max_pages + 1):
                                if self.stop_flag:
                                    break
                                if ddg_page > 1:
                                    await self.broadcast({"type": "status", "message": f"  📄 DDG page {ddg_page}/{max_pages}..."})
                                    await asyncio.sleep(delay_between_pages)
                                    # Click Next (form with class nav-link)
                                    next_form = await self.page.query_selector("form.nav-link")
                                    if not next_form:
                                        no_more_ddg_pages = True
                                        await self.broadcast({"type": "status", "message": f"  ⚠️ No more DDG pages"})
                                        break
                                    try:
                                        await next_form.evaluate("form => form.submit()")
                                        await asyncio.sleep(2)
                                    except Exception:
                                        break
                                else:
                                    # Use domcontentloaded - networkidle often never completes (DDG has persistent connections)
                                    await self.page.goto(ddg_url, wait_until="domcontentloaded", timeout=60000)
                                    await self.broadcast({"type": "status", "message": "  📄 Page loaded, scanning for results..."})
                                    ss = await self.take_screenshot(force=True)
                                    if ss:
                                        await self.broadcast({"type": "screenshot", "data": ss})
                                    await asyncio.sleep(5)  # Wait for results to fully render
                                # DuckDuckGo HTML: .result = result box, .result__a or .result__url = link
                                result_elems = await self.page.query_selector_all(".result")
                                if not result_elems:
                                    result_elems = await self.page.query_selector_all("article, .web-result")
                                if ddg_page == 1:
                                    await self.broadcast({"type": "status", "message": f"  📊 Page 1: {len(result_elems)} result boxes"})
                                if not result_elems:
                                    # Fallback: get ALL DDG redirect links (uddg= or /l/ path)
                                    uddg_links = await self.page.query_selector_all("a[href*='uddg=']")
                                    if not uddg_links:
                                        uddg_links = await self.page.query_selector_all("a[href*='/l/']")
                                    if uddg_links:
                                        await self.broadcast({"type": "status", "message": f"  📊 Found {len(uddg_links)} links (fallback mode)"})
                                        result_elems = uddg_links  # Process as link elements
                                    else:
                                        await self.broadcast({"type": "status", "message": "  ⚠️ No result elements found — DDG layout may have changed"})
                                # Collect ALL links from each result (box may have title + url links)
                                for elem in result_elems:
                                    if self.stop_flag:
                                        break
                                    links_in_elem = await elem.query_selector_all("a[href*='uddg='], a[href*='/l/']")
                                    if not links_in_elem:
                                        link_el = await elem.query_selector(".result__a") or await elem.query_selector(".result__url")
                                        if link_el:
                                            links_in_elem = [link_el]
                                    if not links_in_elem:
                                        tag = await elem.evaluate("e => e.tagName ? e.tagName.toLowerCase() : ''")
                                        if tag == "a":
                                            links_in_elem = [elem]
                                    for link_el in links_in_elem:
                                        try:
                                            href = await link_el.get_attribute("href")
                                            title = (await link_el.inner_text() or "").strip() or "PDF"
                                            if not href:
                                                continue
                                            # Resolve DDG redirect (uddg=encoded_url)
                                            if "uddg=" in href or "/l/" in href:
                                                try:
                                                    from urllib.parse import urlparse, parse_qs, unquote
                                                    parsed = urlparse(href if href.startswith("http") else "https://duckduckgo.com" + href)
                                                    qs = parse_qs(parsed.query)
                                                    if "uddg" in qs:
                                                        href = unquote(qs["uddg"][0])
                                                except Exception:
                                                    pass
                                            kind = _classify_ddg_serp_href(href, ddg_html_first_mode)
                                            if href in processed_urls or kind is None:
                                                continue
                                            processed_urls.add(href)
                                            pdf_count += 1
                                            display_link = urlparse(href).netloc if href.startswith("http") else ""
                                            label = "PDF" if kind == "pdf" else "page"
                                            await self.broadcast({
                                                "type": "status",
                                                "message": f"  📄 [{pdf_count}] ({label}) {title[:50]}...",
                                            })
                                            if pdf_count % 10 == 0:  # Screenshot every 10 PDFs for Live Browser View
                                                ss = await self.take_screenshot()
                                                if ss:
                                                    await self.broadcast({"type": "screenshot", "data": ss})
                                            if kind == "pdf":
                                                pdf_leads = await self.extract_from_pdf(href, title, display_link)
                                            else:
                                                pdf_leads = await self.extract_from_html(href, title, display_link)
                                            if pdf_leads:
                                                filtered_pdf, dom_drop = filter_leads_by_email_domains(
                                                    pdf_leads, email_rules
                                                )
                                                if dom_drop:
                                                    await self.broadcast({
                                                        "type": "status",
                                                        "message": f"  🎯 Email filter: dropped {dom_drop} lead(s) (not on allowlist)",
                                                    })
                                                if not filtered_pdf:
                                                    continue
                                                for lead in filtered_pdf:
                                                    lead["search_query"] = ddg_q_sent
                                                query_leads.extend(filtered_pdf)
                                                total_leads_extracted += len(filtered_pdf)
                                                await self.broadcast({"type": "lead_count", "count": total_leads_extracted, "target": target_leads})
                                                try:
                                                    if master_search_id:
                                                        save_leads(
                                                            master_search_id,
                                                            list(all_leads) + query_leads,
                                                            replace=True,
                                                        )
                                                    await self.broadcast({"type": "status", "message": f"  💾 Saved ({len(query_leads)} this pass, {len(all_leads) + len(query_leads)} cumulative)"})
                                                except Exception:
                                                    pass
                                        except Exception as e:
                                            await self.broadcast({"type": "status", "message": f"  ⚠️ Result error: {str(e)[:40]}"})
                                            continue
                            if not result_elems:
                                await self.broadcast({"type": "status", "message": "⚠️ No DuckDuckGo results found"})
                        except Exception as e:
                            await self.broadcast({"type": "status", "message": f"❌ DuckDuckGo error: {str(e)[:60]}"})
                            ddg_flow_error = True
                            # Do not `continue` — we still want query variations below when results were poor.
                        # DDG done - finalize this query here and skip Google flow.
                        # This prevents accidental fallback to Google/CAPTCHA when DDG is selected.
                        if query_leads:
                            all_leads.extend(query_leads)
                            self.all_leads_buffer.extend(query_leads)
                            await self.broadcast({
                                "type": "status",
                                "message": f"✅ Query {query_idx} complete (DuckDuckGo): {len(query_leads)} leads",
                            })
                            if target_leads > 0 and total_leads_extracted >= target_leads:
                                await self.broadcast({
                                    "type": "status",
                                    "message": f"🎯 Target reached! Extracted {total_leads_extracted} leads (target: {target_leads}). Stopping...",
                                })
                                self.stop_flag = True
                        else:
                            await self.broadcast({
                                "type": "status",
                                "message": f"⚠️ Query {query_idx}: No leads extracted from DuckDuckGo",
                            })
                        # Add query variations when: pages exhausted OR yield is low vs target (~10k soft floor)
                        under_target = target_leads > 0 and total_leads_extracted < target_leads
                        no_limit_mode = target_leads == 0
                        max_auto_variations = min(60, len(DDG_QUERY_VARIATIONS))
                        yield_threshold = (
                            min(10000, max(500, target_leads // 10))
                            if target_leads > 0
                            else 2500
                        )
                        under_yield = len(query_leads) < yield_threshold and (
                            target_leads == 0 or len(query_leads) < int(target_leads * 0.95)
                        )
                        can_add = (
                            variation_idx < len(DDG_QUERY_VARIATIONS)
                            and variation_idx < max_auto_variations
                            and (under_target or no_limit_mode)
                        )
                        # Expand when: no more SERP pages, or finished max_pages with low yield, or DDG crashed with 0 leads
                        if (
                            can_add
                            and not self.stop_flag
                            and (
                                no_more_ddg_pages
                                or (under_yield and ddg_page == max_pages)
                                or (ddg_flow_error and len(query_leads) == 0)
                            )
                        ):
                            base = _strip_trailing_filetype_pdf(query)
                            suffix = DDG_QUERY_VARIATIONS[variation_idx].strip()
                            variation_idx += 1
                            if "filetype:" in suffix.lower():
                                new_q = (base + " " + suffix).replace("  ", " ").strip()
                            elif ddg_html_first_mode:
                                new_q = (base + " " + suffix).replace("  ", " ").strip()
                            else:
                                new_q = (base + " " + suffix + " filetype:pdf").replace("  ", " ").strip()
                            query_queue.append(new_q)
                            reason = (
                                f"reach {target_leads} leads (soft floor {yield_threshold}/pass)"
                                if target_leads > 0
                                else f"expand search (floor {yield_threshold} leads/pass)"
                            )
                            await self.broadcast({
                                "type": "status",
                                "message": f"  🔄 Adding query variation ({reason}): \"{new_q[:55]}...\"",
                            })
                        await self.broadcast({"type": "leads", "data": query_leads})
                        continue
                    else:
                        # ─── Google flow ────────────────────────────────────────────────────────
                        # STEP 1: Navigate to Google (retry up to 3 times so first page does not quit the run)
                        step1_ok = False
                        for step1_attempt in range(1, 4):
                            if self.stop_flag:
                                break
                            await self.broadcast({"type": "status", "message": f"🌐 [STEP 1] Opening Google... (attempt {step1_attempt}/3)"})
                            try:
                                await self.page.goto("https://www.google.com", wait_until="domcontentloaded", timeout=30000)
                                await asyncio.sleep(2)
                                await self.page.wait_for_load_state("networkidle", timeout=30000)
                                if "google.com" not in self.page.url.lower():
                                    raise Exception(f"Navigation failed - URL is {self.page.url}")
                                await self.broadcast({"type": "status", "message": "✅ [STEP 1] Successfully navigated to Google"})
                                screenshot = await self.take_screenshot(force=True)
                                if screenshot:
                                    await self.broadcast({"type": "screenshot", "data": screenshot})
                                step1_ok = True
                                break
                            except Exception as e:
                                await self.broadcast({
                                    "type": "status",
                                    "message": f"⚠️ [STEP 1] Attempt {step1_attempt}/3 failed: {str(e)[:50]}",
                                })
                                if step1_attempt < 3:
                                    await asyncio.sleep(3)  # Brief pause before retry
                        if not step1_ok:
                            await self.broadcast({"type": "status", "message": "❌ [STEP 1] Could not load Google after 3 attempts. Skipping query."})
                            continue

                    # Check for Google CAPTCHA/sorry page ("unusual traffic") - wait for user to solve
                    current_url = self.page.url.lower()
                    page_content = (await self.page.content()).lower()
                    if "sorry" in current_url or "recaptcha" in current_url or "unusual traffic" in page_content:
                        await self.broadcast({
                            "type": "status",
                            "message": "⚠️ Google CAPTCHA detected! Please solve the 'I'm not a robot' checkbox in the browser. Waiting up to 60 seconds...",
                        })
                        for wait_sec in range(60, 0, -5):
                            if self.stop_flag:
                                break
                            await asyncio.sleep(5)
                            url_now = self.page.url.lower()
                            if "sorry" not in url_now and "recaptcha" not in url_now:
                                await self.broadcast({"type": "status", "message": "✅ CAPTCHA solved! Continuing..."})
                                break
                        else:
                            await self.broadcast({"type": "status", "message": "❌ CAPTCHA not solved in time. Try DuckDuckGo (Settings → Search Engine) to avoid this."})
                            continue

                    await asyncio.sleep(delay_between_actions)

                    # Accept cookies if present
                    try:
                        accept_btn = await self.page.query_selector("button:has-text('Accept'), button:has-text('I agree')")
                        if accept_btn:
                            await accept_btn.click()
                            await self.broadcast({"type": "status", "message": "✅ Accepted cookies"})
                            await asyncio.sleep(0.5)
                    except Exception:
                        pass

                    # STEP 2: Paste search query (instant - more reliable than typing)
                    await self.broadcast({"type": "status", "message": f"⌨️ [STEP 2] Pasting: \"{query[:50]}...\""})
                    try:
                        search_box = await self.page.wait_for_selector('textarea[name="q"], input[name="q"]', timeout=10000)
                        if not search_box:
                            raise Exception("Search box element not found")
                        await search_box.click()
                        await asyncio.sleep(0.2)
                        await search_box.fill("")  # Clear first
                        await search_box.fill(effective_query)  # Includes optional site: restriction
                        await asyncio.sleep(0.2)
                        
                        input_value = await search_box.input_value()
                        if input_value != query:
                            raise Exception(f"Input validation failed - expected '{query}', got '{input_value}'")
                        await self.broadcast({"type": "status", "message": "✅ [STEP 2] Query typed successfully"})
                        screenshot = await self.take_screenshot(force=True)
                        if screenshot:
                            await self.broadcast({"type": "screenshot", "data": screenshot})
                    except Exception as e:
                        await self.broadcast({
                            "type": "status",
                            "message": f"❌ [STEP 2] Could not type query: {str(e)[:50]}. Skipping query.",
                        })
                        continue

                    # STEP 3: Press Enter and wait for results
                    await self.broadcast({"type": "status", "message": "🔍 [STEP 3] Searching..."})
                    try:
                        # Check for reCAPTCHA before searching
                        recaptcha = await self.page.query_selector("iframe[src*='recaptcha'], div[class*='recaptcha']")
                        if recaptcha:
                            await self.broadcast({
                                "type": "status",
                                "message": "⚠️ [STEP 3] reCAPTCHA detected! Waiting 10 seconds...",
                            })
                            await asyncio.sleep(10)  # Wait for manual solve or auto-solve
                        
                        await self.page.keyboard.press("Enter")
                        await asyncio.sleep(1)  # Human-like pause
                        
                        # Wait for URL to change to search page
                        try:
                            await self.page.wait_for_url("**/search**", timeout=30000)
                        except Exception:
                            # Check if we hit reCAPTCHA
                            current_url = self.page.url
                            if "sorry" in current_url.lower() or "recaptcha" in current_url.lower():
                                await self.broadcast({
                                    "type": "status",
                                    "message": "⚠️ [STEP 3] reCAPTCHA page detected! Please solve manually or wait...",
                                })
                                await asyncio.sleep(15)  # Wait for manual solve
                                # Try to continue
                                try:
                                    await self.page.goto(f"https://www.google.com/search?q={quote_plus(effective_query)}", wait_until="networkidle", timeout=30000)
                                except Exception:
                                    raise Exception("reCAPTCHA not solved")
                            pass  # URL might not change, continue anyway
                        
                        await self.page.wait_for_load_state("networkidle", timeout=30000)
                        await asyncio.sleep(3)  # Give results time to render
                        
                        # Check again for reCAPTCHA on results page
                        recaptcha_check = await self.page.query_selector("iframe[src*='recaptcha'], div[class*='recaptcha']")
                        if recaptcha_check:
                            await self.broadcast({
                                "type": "status",
                                "message": "⚠️ [STEP 3] reCAPTCHA on results page! Waiting 15 seconds...",
                            })
                            await asyncio.sleep(15)
                        
                        # Wait for results selector to appear
                        try:
                            await self.page.wait_for_selector("div.g", timeout=10000)
                        except Exception:
                            await self.broadcast({
                                "type": "status",
                                "message": "⚠️ [STEP 3] Results selector not found, waiting longer...",
                            })
                            await asyncio.sleep(3)
                        
                        # Validate results loaded
                        result_elements = await self.page.query_selector_all("div.g")
                        if len(result_elements) == 0:
                            # Try alternative selectors
                            result_elements = await self.page.query_selector_all("div[data-ved]")
                            if len(result_elements) == 0:
                                raise Exception("No search results found")
                        await self.broadcast({
                            "type": "status", 
                            "message": f"✅ [STEP 3] Search results loaded ({len(result_elements)} results found)"
                        })
                        screenshot = await self.take_screenshot(force=True)
                        if screenshot:
                            await self.broadcast({"type": "screenshot", "data": screenshot})
                    except Exception as e:
                        await self.broadcast({
                            "type": "status",
                            "message": f"⚠️ [STEP 3] Search timeout: {str(e)[:50]}. Continuing anyway...",
                        })
                        # Try to continue anyway
                        try:
                            await asyncio.sleep(5)  # Give it more time to load
                            result_elements = await self.page.query_selector_all("div.g")
                            if len(result_elements) == 0:
                                result_elements = await self.page.query_selector_all("div[data-ved]")
                            if len(result_elements) > 0:
                                await self.broadcast({
                                    "type": "status",
                                    "message": f"✅ [STEP 3] Found {len(result_elements)} results after extended wait",
                                })
                            screenshot = await self.take_screenshot(force=True)
                            if screenshot:
                                await self.broadcast({"type": "screenshot", "data": screenshot})
                        except Exception:
                            pass

                    # Extract results from multiple pages and PROCESS PDFs IMMEDIATELY
                    google_no_more_pages = False
                    for page_num in range(1, max_pages + 1):
                        if self.stop_flag:
                            break

                        if page_num > 1:
                            await self.broadcast({
                                "type": "status",
                                "message": f"⏳ Waiting {delay_between_pages}s before page {page_num}...",
                            })
                            await asyncio.sleep(delay_between_pages)

                            # Click Next button
                            try:
                                next_btn = await self.page.query_selector('a#pnnext, a:has-text("Next")')
                                if next_btn:
                                    await self.broadcast({"type": "status", "message": f"➡️ Clicking 'Next' (page {page_num})..."})
                                    await next_btn.click()
                                    try:
                                        await self.page.wait_for_load_state("networkidle", timeout=30000)
                                        screenshot = await self.take_screenshot(force=True)
                                        if screenshot:
                                            await self.broadcast({"type": "screenshot", "data": screenshot})
                                    except Exception:
                                        await asyncio.sleep(3)  # Fallback wait
                                        screenshot = await self.take_screenshot(force=True)
                                        if screenshot:
                                            await self.broadcast({"type": "screenshot", "data": screenshot})
                                else:
                                    await self.broadcast({"type": "status", "message": "⚠️ No more pages"})
                                    google_no_more_pages = True
                                    break
                            except Exception:
                                await self.broadcast({"type": "status", "message": "⚠️ Could not navigate to next page"})
                                google_no_more_pages = True
                                break

                        # STEP 4: Extract results and CLICK ALL PDFs (query already filters for filetype:pdf)
                        await self.broadcast({"type": "status", "message": f"📋 [STEP 4] Scanning page {page_num} for results..."})
                        try:
                            # Wait for results to be available
                            try:
                                await self.page.wait_for_selector("div.g", timeout=10000)
                            except Exception:
                                # Try alternative selector
                                try:
                                    await self.page.wait_for_selector("div[data-ved]", timeout=5000)
                                except Exception:
                                    pass
                            
                            result_elements = await self.page.query_selector_all("div.g")
                            if len(result_elements) == 0:
                                # Try alternative selector
                                result_elements = await self.page.query_selector_all("div[data-ved]")
                            
                            if len(result_elements) == 0:
                                await self.broadcast({
                                    "type": "status",
                                    "message": f"⚠️ [STEP 4] No result elements found on page {page_num}",
                                })
                                continue
                            await self.broadcast({
                                "type": "status",
                                "message": f"✅ [STEP 4] Found {len(result_elements)} result elements",
                            })
                            pdf_count = 0
                            processed_urls = set()  # Track processed URLs to avoid duplicates

                            for elem in result_elements:
                                try:
                                    title_elem = await elem.query_selector("h3")
                                    link_elem = await elem.query_selector("a")

                                    if not title_elem or not link_elem:
                                        continue

                                    title = await title_elem.inner_text()
                                    url = await link_elem.get_attribute("href")

                                    if not url:
                                        continue

                                    # Extract actual URL from Google redirect URL
                                    if url.startswith("/url?q="):
                                        from urllib.parse import unquote
                                        try:
                                            actual_url = unquote(url.split("&")[0].replace("/url?q=", ""))
                                            url = actual_url
                                        except Exception:
                                            pass

                                    # Skip Google internal URLs and already processed URLs
                                    if "google.com" in url or url.startswith("/") or url in processed_urls:
                                        continue
                                    
                                    processed_urls.add(url)

                                    cite_elem = await elem.query_selector("cite")
                                    display_link = await cite_elem.inner_text() if cite_elem else url.split("/")[2] if "/" in url else ""

                                    # STEP 5: Since query has filetype:pdf, ALL results should be PDFs - CLICK THEM ALL
                                    pdf_count += 1
                                    await self.broadcast({
                                        "type": "status",
                                        "message": f"  📄 [STEP 5.{pdf_count}] Processing result #{pdf_count}: {title[:50]}",
                                    })
                                    
                                    # STEP 6: CLICK THIS RESULT IMMEDIATELY (process now!)
                                    try:
                                        await self.broadcast({
                                            "type": "status",
                                            "message": f"  🖱️ [STEP 6.{pdf_count}] Clicking result #{pdf_count}...",
                                        })
                                        
                                        # Scroll into view FIRST
                                        await link_elem.scroll_into_view_if_needed()
                                        await asyncio.sleep(0.5)
                                        
                                        # Get current URL before click
                                        current_url_before = self.page.url
                                        
                                        # Click the title (most reliable)
                                        await self.broadcast({
                                            "type": "status",
                                            "message": f"  🖱️ Clicking title: {title[:40]}...",
                                        })
                                        
                                        try:
                                            await title_elem.click(timeout=5000)
                                            await self.broadcast({
                                                "type": "status",
                                                "message": f"  ✅ Clicked title element",
                                            })
                                        except Exception as click_err:
                                            # Fallback to link element
                                            await self.broadcast({
                                                "type": "status",
                                                "message": f"  ⚠️ Title click failed, trying link: {str(click_err)[:40]}",
                                            })
                                            try:
                                                await link_elem.click(timeout=5000)
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  ✅ Clicked link element",
                                                })
                                            except Exception as link_err:
                                                # Final fallback: use JavaScript click
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  ⚠️ Link click failed, using JS click: {str(link_err)[:40]}",
                                                })
                                                await self.page.evaluate("""
                                                    (element) => {
                                                        element.click();
                                                    }
                                                """, link_elem)
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  ✅ Clicked via JavaScript",
                                                })
                                        
                                        await asyncio.sleep(2)  # Wait for navigation
                                        
                                        screenshot = await self.take_screenshot(force=True)
                                        if screenshot:
                                            await self.broadcast({"type": "screenshot", "data": screenshot})
                                        
                                        # Verify navigation happened
                                        await asyncio.sleep(1)
                                        current_url_after = self.page.url
                                        
                                        if current_url_after == current_url_before:
                                            await self.broadcast({
                                                "type": "status",
                                                "message": f"  ⚠️ Click did not navigate! Trying direct navigation to: {url[:60]}...",
                                            })
                                            # Fallback: Navigate directly to URL
                                            try:
                                                await self.page.goto(url, wait_until="networkidle", timeout=30000)
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  ✅ Navigated directly",
                                                })
                                            except Exception as nav_error:
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  ❌ Direct navigation failed: {str(nav_error)[:60]}. Skipping...",
                                                })
                                                # Go back to search results before continuing
                                                try:
                                                    await self.page.go_back()
                                                    await self.page.wait_for_load_state("networkidle", timeout=10000)
                                                except Exception:
                                                    await self.page.goto(f"https://www.google.com/search?q={quote_plus(effective_query)}", wait_until="networkidle", timeout=15000)
                                                continue  # Skip this result
                                        else:
                                            await self.broadcast({
                                                "type": "status",
                                                "message": f"  ✅ Navigation successful! URL changed to: {current_url_after[:60]}",
                                            })
                                        
                                        # PDFs: Skip networkidle - browser PDF viewer often never reaches it (keeps loading thumbnails).
                                        # extract_from_pdf downloads via httpx, so we don't need the page. Brief wait then proceed.
                                        is_pdf = url.lower().endswith(".pdf") or "/pdf" in url.lower()
                                        if is_pdf:
                                            await asyncio.sleep(2)  # Brief pause, then extract (httpx downloads independently)
                                        else:
                                            try:
                                                await self.page.wait_for_load_state("networkidle", timeout=15000)
                                                await asyncio.sleep(2)
                                            except Exception:
                                                await asyncio.sleep(3)
                                        screenshot = await self.take_screenshot(force=True)
                                        if screenshot:
                                            await self.broadcast({"type": "screenshot", "data": screenshot})
                                        
                                        # STEP 7: Extract leads from PDF/page
                                        await self.broadcast({
                                            "type": "status",
                                            "message": f"  📥 [STEP 7.{pdf_count}] Extracting leads from result #{pdf_count}...",
                                        })
                                        
                                        pdf_leads = await self.extract_from_pdf(
                                            url,
                                            title,
                                            display_link,
                                        )
                                        
                                        if pdf_leads:
                                            filtered_pdf, dom_drop = filter_leads_by_email_domains(
                                                pdf_leads, email_rules
                                            )
                                            if dom_drop:
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  🎯 Email filter: dropped {dom_drop} lead(s) (not on allowlist)",
                                                })
                                            if not filtered_pdf:
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  ⚠️ [STEP 7.{pdf_count}] No leads left after domain filter",
                                                })
                                            else:
                                                for lead in filtered_pdf:
                                                    lead["search_query"] = effective_query
                                                query_leads.extend(filtered_pdf)
                                                total_leads_extracted += len(filtered_pdf)
                                                await self.broadcast({
                                                    "type": "lead_count",
                                                    "count": total_leads_extracted,
                                                    "target": target_leads,
                                                })
                                                await self.broadcast({
                                                    "type": "status",
                                                    "message": f"  ✅ [STEP 7.{pdf_count}] Extracted {len(filtered_pdf)} leads | Total: {total_leads_extracted} leads",
                                                })
                                                try:
                                                    if master_search_id:
                                                        save_leads(
                                                            master_search_id,
                                                            list(all_leads) + query_leads,
                                                            replace=True,
                                                        )
                                                    await self.broadcast({
                                                        "type": "status",
                                                        "message": f"  💾 Saved to DB ({len(query_leads)} this pass, {len(all_leads) + len(query_leads)} cumulative)",
                                                    })
                                                except Exception as es:
                                                    await self.broadcast({"type": "status", "message": f"  ⚠️ Save error: {str(es)[:40]}"})
                                        else:
                                            await self.broadcast({
                                                "type": "status",
                                                "message": f"  ⚠️ [STEP 7.{pdf_count}] No leads extracted",
                                            })
                                        
                                        # STEP 8: Go back to search results
                                        await self.broadcast({
                                            "type": "status",
                                            "message": f"  ⬅️ [STEP 8.{pdf_count}] Returning to search results...",
                                        })
                                        try:
                                            await self.page.go_back()
                                            await self.page.wait_for_load_state("networkidle", timeout=15000)
                                            await asyncio.sleep(1)
                                            screenshot = await self.take_screenshot(force=True)
                                            if screenshot:
                                                await self.broadcast({"type": "screenshot", "data": screenshot})
                                        except Exception:
                                            # If back fails, navigate to Google search again
                                            await self.page.goto(f"https://www.google.com/search?q={quote_plus(effective_query)}", wait_until="networkidle", timeout=15000)
                                        
                                    except Exception as e:
                                        import traceback
                                        error_trace = traceback.format_exc()
                                        await self.broadcast({
                                            "type": "status",
                                            "message": f"  ❌ Result #{pdf_count} error: {str(e)[:80]}",
                                        })
                                        # Try to get back to search results
                                        try:
                                            await self.page.go_back()
                                            await self.page.wait_for_load_state("networkidle", timeout=10000)
                                        except Exception:
                                            await self.page.goto(f"https://www.google.com/search?q={quote_plus(effective_query)}", wait_until="networkidle", timeout=15000)

                                except Exception:
                                    continue

                            if pdf_count > 0:
                                await self.broadcast({
                                    "type": "status",
                                    "message": f"✅ Page {page_num}: Processed {pdf_count} result(s)",
                                })
                            else:
                                await self.broadcast({"type": "status", "message": f"⚠️ Page {page_num}: No results found"})

                        except Exception as e:
                            await self.broadcast({
                                "type": "status",
                                "message": f"❌ Error scanning page: {str(e)[:60]}",
                            })
                            # Continue to next page even if this page had errors
                            continue

                    # If target was reached inside the page loop, exit query loop too
                    if self.stop_flag:
                        break

                    # Save leads after each query (database only — no auto file export)
                    if query_leads:
                        all_leads.extend(query_leads)
                        self.all_leads_buffer.extend(query_leads)  # Keep buffer updated
                        # total_leads_extracted already updated per-PDF in inner loop; do not double-count
                        
                        # Broadcast real-time lead count update
                        await self.broadcast({
                            "type": "lead_count",
                            "count": total_leads_extracted,
                            "target": target_leads,
                        })
                        
                        # SAVE TO DATABASE (full cumulative list for this run)
                        try:
                            if master_search_id:
                                saved_count = save_leads(master_search_id, all_leads, replace=True)
                            else:
                                saved_count = 0
                            await self.broadcast({
                                "type": "status",
                                "message": f"💾 Saved {saved_count} leads to database (session #{master_search_id}) | Total extracted: {total_leads_extracted}",
                            })
                        except Exception as e:
                            await self.broadcast({
                                "type": "status",
                                "message": f"⚠️ Database save error: {str(e)[:60]}",
                            })
                        
                        await self.broadcast({
                            "type": "status",
                            "message": f"✅ Query {query_idx + 1} complete: {len(query_leads)} leads extracted | Total: {total_leads_extracted} leads",
                        })
                        
                        # Check if target reached
                        if target_leads > 0 and total_leads_extracted >= target_leads:
                            await self.broadcast({
                                "type": "status",
                                "message": f"🎯 Target reached! Extracted {total_leads_extracted} leads (target: {target_leads}). Stopping...",
                            })
                            self.stop_flag = True
                            break

                        # No automatic PDF/CSV export — sessions are in the DB; user exports from the app UI.
                        await self.broadcast({
                            "type": "status",
                            "message": "📁 Leads are in the database for this session — use **Saved sessions for this query** or **Saved Leads** to validate/download when you want.",
                        })
                        await self.broadcast({"type": "leads", "data": query_leads})
                    else:
                        await self.broadcast({
                            "type": "status",
                            "message": f"⚠️ Query {query_idx + 1}: No leads extracted",
                        })

                    # Google: rotate query wording when results are thin (same variation list as DuckDuckGo)
                    if search_engine != "duckduckgo":
                        gq = query.strip()
                        g_base = (
                            gq.replace(" filetype:pdf", "")
                            .replace(" filetype: pdf", "")
                            .strip()
                        )
                        under_target_g = target_leads > 0 and total_leads_extracted < target_leads
                        no_limit_g = target_leads == 0
                        max_auto_g = min(60, len(DDG_QUERY_VARIATIONS))
                        yield_thr_g = (
                            min(10000, max(500, target_leads // 10))
                            if target_leads > 0
                            else 2500
                        )
                        under_yield_g = len(query_leads) < yield_thr_g and (
                            target_leads == 0 or len(query_leads) < int(target_leads * 0.95)
                        )
                        can_add_g = (
                            variation_idx < len(DDG_QUERY_VARIATIONS)
                            and variation_idx < max_auto_g
                            and (under_target_g or no_limit_g)
                        )
                        if (
                            can_add_g
                            and not self.stop_flag
                            and (
                                google_no_more_pages
                                or (under_yield_g and page_num == max_pages)
                            )
                        ):
                            suffix_g = DDG_QUERY_VARIATIONS[variation_idx].strip()
                            variation_idx += 1
                            if "filetype:" in suffix_g.lower():
                                new_qg = (g_base + " " + suffix_g).replace("  ", " ").strip()
                            else:
                                new_qg = (g_base + " " + suffix_g + " filetype:pdf").replace("  ", " ").strip()
                            query_queue.append(new_qg)
                            reason_g = (
                                f"reach {target_leads} leads (Google)"
                                if target_leads > 0
                                else "expand Google search"
                            )
                            await self.broadcast({
                                "type": "status",
                                "message": f"  🔄 Adding query variation ({reason_g}): \"{new_qg[:55]}...\"",
                            })

                    await self.broadcast({"type": "status", "message": ""})
                
                except Exception as e:
                    # Catch any errors in query processing and continue
                    import traceback
                    error_msg = str(e)
                    error_trace = traceback.format_exc()
                    await self.broadcast({
                        "type": "status",
                        "message": f"❌ Query {query_idx + 1} error: {error_msg[:100]}",
                    })
                    await self.broadcast({
                        "type": "status",
                        "message": f"⚠️ Continuing to next query...",
                    })
                    # Log full error for debugging
                    print(f"Query {query_idx + 1} error: {error_trace}")
                    # Save any leads we got before the error (replace=True - full replace for this search)
                    if 'query_leads' in locals() and query_leads and master_search_id:
                        try:
                            all_leads.extend(query_leads)
                            self.all_leads_buffer.extend(query_leads)
                            save_leads(master_search_id, all_leads, replace=True)
                        except Exception:
                            pass
                    continue

            # Final summary - Ensure all data is saved
            await self.broadcast({
                "type": "status",
                "message": f"🎉 Automation complete! {len(all_leads)} total leads extracted",
            })
            
            # CRITICAL: Final database save (ensure nothing is lost)
            if all_leads and self.current_session_id:
                try:
                    # Update final counts
                    from app.database.db import get_connection
                    conn = get_connection()
                    conn.execute(
                        "UPDATE searches SET num_results = ?, num_leads = ? WHERE id = ?",
                        (len(all_leads), len(all_leads), self.current_session_id)
                    )
                    conn.commit()
                    conn.close()
                    await self.broadcast({
                        "type": "status",
                        "message": f"💾 Final database update complete (session #{self.current_session_id})",
                    })
                except Exception as e:
                    await self.broadcast({
                        "type": "status",
                        "message": f"⚠️ Final DB update error: {str(e)[:60]}",
                    })
            
            await self.broadcast({"type": "complete", "data": all_leads})

        except Exception as e:
            import traceback
            print(f"[Automation] ERROR: {e}", file=sys.stderr, flush=True)
            traceback.print_exc()
            error_msg = str(e)
            await self.broadcast({
                "type": "error",
                "message": f"❌ Automation error: {error_msg}",
            })
            # CRITICAL: Save buffer to DB on error (never lose leads)
            if self.all_leads_buffer and self.current_session_id:
                try:
                    save_leads(self.current_session_id, self.all_leads_buffer, replace=True)
                    await self.broadcast({"type": "status", "message": f"💾 Saved {len(self.all_leads_buffer)} leads to database (recovery)"})
                except Exception:
                    pass
        finally:
            # CRITICAL: Save buffer to database BEFORE closing
            final_leads = all_leads if 'all_leads' in locals() else self.all_leads_buffer
            
            if final_leads and self.current_session_id:
                try:
                    await self.broadcast({
                        "type": "status",
                        "message": f"💾 Saving {len(final_leads)} leads before closing...",
                    })
                    save_leads(self.current_session_id, final_leads, replace=True)
                    await self.broadcast({
                        "type": "status",
                        "message": f"✅ Saved to database (session #{self.current_session_id})",
                    })
                except Exception as e:
                    await self.broadcast({
                        "type": "status",
                        "message": f"⚠️ Final save error: {str(e)[:60]}",
                    })
            
            # Cleanup browser (closes context + browser so external window exits)
            cleanup_errors = await self.shutdown_playwright()
            
            # CRITICAL: Always send completion signal, even on error
            # Set is_running to False FIRST so UI knows it's done
            self.is_running = False
            self.current_session_id = None
            
            # Send completion signal (multiple attempts)
            completion_sent = False
            for attempt in range(3):
                try:
                    await self.broadcast({
                        "type": "complete",
                        "data": final_leads if final_leads else [],
                    })
                    completion_sent = True
                    break
                except Exception as e:
                    if attempt < 2:
                        await asyncio.sleep(0.5)  # Retry
                    else:
                        # Last attempt failed - log but continue
                        print(f"Failed to send completion signal: {e}")
            
            if cleanup_errors:
                try:
                    await self.broadcast({
                        "type": "status",
                        "message": f"🔚 Browser closed (warnings: {', '.join(cleanup_errors)})",
                    })
                except Exception:
                    pass
            else:
                try:
                    await self.broadcast({"type": "status", "message": "🔚 Browser closed"})
                except Exception:
                    pass


manager = AutomationManager()


async def _do_stop(mgr: AutomationManager) -> None:
    """
    Hard-stop the running automation.
    1. Set flags so every stop_flag check inside run_automation exits its loop.
    2. Cancel the asyncio Task — raises CancelledError at the next await point,
       which unwinds the coroutine even if it's deep inside a page scrape.
    3. Shut down Playwright so the visible browser window closes immediately.
    4. Save buffered leads to DB and broadcast complete.
    """
    mgr.stop_flag = True
    mgr.is_running = False

    # Cancel the task immediately — this is the key fix.
    # Previously the task ran forever because only stop_flag was set.
    if mgr.task and not mgr.task.done():
        mgr.task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(mgr.task), timeout=2.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass  # Expected — task was cancelled

    await mgr.broadcast({"type": "status", "message": "🛑 Stop requested — saving leads and closing browser…"})

    # Save buffered leads before closing browser
    if mgr.all_leads_buffer and mgr.current_session_id:
        try:
            saved_count = save_leads(mgr.current_session_id, mgr.all_leads_buffer, replace=True)
            await mgr.broadcast({"type": "status", "message": f"💾 Saved {saved_count} leads to database before stopping"})
        except Exception as e:
            await mgr.broadcast({"type": "status", "message": f"⚠️ Error saving leads on stop: {str(e)[:60]}"})

    # Close browser window
    pw_errs = await mgr.shutdown_playwright()
    status_msg = f"🔚 Browser shutdown: {', '.join(pw_errs[:3])}" if pw_errs else "🔚 Browser closed"
    await mgr.broadcast({"type": "status", "message": status_msg})

    # Signal UI that run is complete
    try:
        await mgr.broadcast({"type": "complete", "data": mgr.all_leads_buffer or []})
    except Exception:
        pass

    mgr.task = None


@app.post("/stop")
async def http_stop():
    """HTTP fallback stop — works even if the WebSocket connection was dropped."""
    await _do_stop(manager)
    return {"status": "stopped", "saved": len(manager.all_leads_buffer)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send ping every 30 seconds to keep connection alive
        async def ping_task():
            while True:
                await asyncio.sleep(30)
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
        
        ping_handle = asyncio.create_task(ping_task())
        
        while True:
            try:
                data = await websocket.receive_json()
                command = data.get("command")

                if command == "start":
                    headless_val = bool(data.get("headless", False))
                    print(f"[Automation] START received: headless={headless_val}, queries={len(data.get('queries', []))}", file=sys.stderr, flush=True)
                    if manager.is_running:
                        await websocket.send_json({
                            "type": "error",
                            "message": "⚠️ Automation already running",
                        })
                        continue
                    
                    queries = data.get("queries", [])
                    max_pages = data.get("max_pages", 10)
                    delay_pages = data.get("delay_pages", 3.0)
                    delay_actions = data.get("delay_actions", 1.0)
                    target_leads = data.get("target_leads", 0)
                    raw = data.get("search_engine", "duckduckgo")
                    search_engine = str(raw).lower().strip() if raw else "duckduckgo"
                    if search_engine not in ("duckduckgo", "google"):
                        search_engine = "duckduckgo"
                    headless = bool(data.get("headless", False))
                    reload_between_queries = bool(data.get("reload_between_queries", False))
                    manager.send_screenshots = bool(data.get("send_screenshots", True))

                    # Run automation in background — store task so Stop can cancel it
                    manager.task = asyncio.create_task(manager.run_automation(
                        queries=queries,
                        max_pages=max_pages,
                        delay_between_pages=delay_pages,
                        delay_between_actions=delay_actions,
                        target_leads=target_leads,
                        search_engine=search_engine,
                        headless=headless,
                        reload_between_queries=reload_between_queries,
                        email_domain_allowlist=str(data.get("email_domain_allowlist") or "").strip(),
                        search_site_domains=str(data.get("search_site_domains") or "").strip(),
                    ))

                elif command == "stop":
                    await _do_stop(manager)
                    
            except Exception as e:
                # Log error but keep connection alive
                try:
                    await websocket.send_json({
                        "type": "error",
                        "message": f"WebSocket error: {str(e)[:100]}",
                    })
                except Exception:
                    break

    except WebSocketDisconnect:
        # CRITICAL: Save to database on disconnect (client closed tab / refreshed)
        if manager.all_leads_buffer and manager.current_session_id:
            try:
                save_leads(manager.current_session_id, manager.all_leads_buffer, replace=True)
                print(f"💾 Saved {len(manager.all_leads_buffer)} leads to DB on disconnect")
            except Exception as e:
                print(f"⚠️ DB save on disconnect failed: {e}")
        manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket)


@app.get("/")
async def root():
    return {"status": "Automation server running", "websocket": "/ws"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
