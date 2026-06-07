"""
TempMail Cart — FastAPI Backend
Proxies all 1secmail API calls server-side. Sanitizes email HTML before serving.
"""

import re
import httpx
import bleach
import logging
import secrets
import string
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

# ── App init ──────────────────────────────────────────────────────────────────
app = FastAPI(
    title="TempMail Cart",
    description="Disposable email address service powered by 1secmail.",
    version="1.0.0",
)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ── 1secmail base URL & shared headers ───────────────────────────────────────
MAIL_API = "https://www.1secmail.com/api/v1/"

# Realistic browser headers — 1secmail returns 403 for bot-like user-agents
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.1secmail.com/",
}

# ── Allowed HTML tags for body rendering ─────────────────────────────────────
ALLOWED_TAGS = [
    "a", "abbr", "acronym", "b", "blockquote", "br", "code", "em",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li",
    "ol", "p", "pre", "span", "strong", "table", "tbody", "td",
    "th", "thead", "tr", "u", "ul",
]

ALLOWED_ATTRS = {
    "*":   ["class", "style", "title"],
    "a":   ["href", "title", "rel"],
    "img": ["src", "alt", "width", "height"],
}

# Patterns that are always dangerous regardless of bleach
_DANGER_PATTERNS = [
    re.compile(r"javascript\s*:", re.I),
    re.compile(r"vbscript\s*:", re.I),
    re.compile(r"on\w+\s*=", re.I),          # inline event handlers
    re.compile(r"<\s*script", re.I),
    re.compile(r"<\s*/\s*script", re.I),
    re.compile(r"<\s*iframe", re.I),
    re.compile(r"<\s*object", re.I),
    re.compile(r"<\s*embed", re.I),
    re.compile(r"expression\s*\(", re.I),    # CSS expression()
    re.compile(r"url\s*\(\s*['\"]?\s*javascript", re.I),
]


def sanitize_html(raw: str) -> str:
    """
    Two-pass sanitizer:
      1. Strip known-dangerous patterns with regex.
      2. Allowlist-sanitize with bleach.
    Returns safe HTML string.
    """
    if not raw:
        return ""
    # Pass 1 – regex nuke
    cleaned = raw
    for pattern in _DANGER_PATTERNS:
        cleaned = pattern.sub("", cleaned)

    # Pass 2 – bleach allowlist
    safe = bleach.clean(
        cleaned,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        strip=True,
        strip_comments=True,
    )
    return safe


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse, summary="Main dashboard")
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/privacy", response_class=HTMLResponse, summary="Privacy Policy")
async def privacy(request: Request):
    return templates.TemplateResponse(request, "privacy.html")


@app.get("/privacy-policy", response_class=HTMLResponse, include_in_schema=False)
async def privacy_policy_alias(request: Request):
    return templates.TemplateResponse(request, "privacy.html")


@app.get("/about", response_class=HTMLResponse, summary="About Us")
async def about(request: Request):
    return templates.TemplateResponse(request, "about.html")


@app.get("/about-us", response_class=HTMLResponse, include_in_schema=False)
async def about_us_alias(request: Request):
    return templates.TemplateResponse(request, "about.html")


@app.get("/terms", response_class=HTMLResponse, summary="Terms of Service")
async def terms(request: Request):
    return templates.TemplateResponse(request, "terms.html")


@app.get("/terms-of-service", response_class=HTMLResponse, include_in_schema=False)
async def terms_of_service_alias(request: Request):
    return templates.TemplateResponse(request, "terms.html")


@app.get("/terms-and-conditions", response_class=HTMLResponse, include_in_schema=False)
async def terms_and_conditions_alias(request: Request):
    return templates.TemplateResponse(request, "terms.html")


@app.get("/ads.txt", include_in_schema=False)
async def ads_txt():
    return FileResponse("static/ads.txt")


@app.get("/api/new-email", summary="Generate a fresh disposable email address")
async def new_email():
    """
    Attempts to call 1secmail's random endpoint. If that fails (e.g. 403 Forbidden/downtime),
    it automatically falls back to generating a catchmail.io address server-side.
    """
    try:
        async with httpx.AsyncClient(timeout=10, headers=BROWSER_HEADERS) as client:
            resp = await client.get(MAIL_API, params={"action": "genRandomMailbox", "count": 1})
            resp.raise_for_status()
            data = resp.json()
            if not data:
                raise ValueError("Empty response from 1secmail")
            address: str = data[0]
            username, domain = address.split("@")
            logger.info(f"Generated new address via 1secmail: {address}")
            return {"email": address, "username": username, "domain": domain}
    except Exception as exc:
        logger.warning(f"1secmail email generation failed ({exc}). Falling back to catchmail.io...")
        # Fallback to catchmail.io
        alphabet = string.ascii_lowercase + string.digits
        username = "".join(secrets.choice(alphabet) for _ in range(12))
        domain = "catchmail.io"
        email_addr = f"{username}@{domain}"
        logger.info(f"Generated fallback email address: {email_addr}")
        return {"email": email_addr, "username": username, "domain": domain}


@app.get("/api/check-inbox/{username}/{domain}", summary="List messages in inbox")
async def check_inbox(username: str, domain: str):
    """
    Fetches the inbox list for the given username@domain.
    Supports both 1secmail and catchmail.io domains.
    """
    # Basic input validation
    if not re.match(r"^[a-zA-Z0-9._+-]+$", username):
        raise HTTPException(status_code=400, detail="Invalid username.")
    if not re.match(r"^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", domain):
        raise HTTPException(status_code=400, detail="Invalid domain.")

    if domain == "catchmail.io":
        try:
            url = f"https://api.catchmail.io/api/v1/mailbox"
            async with httpx.AsyncClient(timeout=10, headers=BROWSER_HEADERS) as client:
                resp = await client.get(url, params={"address": f"{username}@{domain}"})
                resp.raise_for_status()
                data = resp.json()
                catchmail_messages = data.get("messages", [])
                mapped_messages = []
                for msg in catchmail_messages:
                    mapped_messages.append({
                        "id": msg.get("id"),
                        "from": msg.get("from"),
                        "subject": msg.get("subject"),
                        "date": msg.get("date"),
                    })
                return {"messages": mapped_messages, "count": len(mapped_messages)}
        except Exception as exc:
            logger.error(f"Catchmail inbox check error: {exc}")
            raise HTTPException(status_code=502, detail="Failed to fetch inbox from fallback service.")
    else:
        try:
            async with httpx.AsyncClient(timeout=10, headers=BROWSER_HEADERS) as client:
                resp = await client.get(
                    MAIL_API,
                    params={"action": "getMessages", "login": username, "domain": domain},
                )
                resp.raise_for_status()
                messages = resp.json()
                return {"messages": messages, "count": len(messages)}
        except Exception as exc:
            logger.error(f"1secmail inbox check error: {exc}")
            raise HTTPException(status_code=502, detail="Failed to fetch inbox.")


@app.get("/api/message/{username}/{domain}/{msg_id}", summary="Fetch and sanitize a single message")
async def get_message(username: str, domain: str, msg_id: str):
    """
    Fetches a single email message and runs the two-pass HTML sanitizer.
    Supports both 1secmail and catchmail.io.
    """
    if not re.match(r"^[a-zA-Z0-9._+-]+$", username):
        raise HTTPException(status_code=400, detail="Invalid username.")
    if not re.match(r"^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", domain):
        raise HTTPException(status_code=400, detail="Invalid domain.")
    
    if domain == "catchmail.io":
        if not re.match(r"^[a-zA-Z0-9-]+$", msg_id):
            raise HTTPException(status_code=400, detail="Invalid message ID format.")
        try:
            url = f"https://api.catchmail.io/api/v1/message/{msg_id}"
            async with httpx.AsyncClient(timeout=10, headers=BROWSER_HEADERS) as client:
                resp = await client.get(url, params={"mailbox": f"{username}@{domain}"})
                resp.raise_for_status()
                msg = resp.json()
            
            body_data = msg.get("body", {})
            mapped_msg = {
                "id": msg.get("id"),
                "from": msg.get("from"),
                "subject": msg.get("subject"),
                "date": msg.get("date"),
                "body": body_data.get("text", ""),
                "htmlBody": body_data.get("html", ""),
            }
            if mapped_msg.get("htmlBody"):
                mapped_msg["htmlBody"] = sanitize_html(mapped_msg["htmlBody"])
            if mapped_msg.get("body"):
                mapped_msg["body"] = bleach.clean(mapped_msg["body"], tags=[], strip=True)
            return mapped_msg
        except Exception as exc:
            logger.error(f"Catchmail fetch message error: {exc}")
            raise HTTPException(status_code=502, detail="Failed to fetch message from fallback service.")
    else:
        if not re.match(r"^\d+$", msg_id):
            raise HTTPException(status_code=400, detail="Invalid message ID format.")
        try:
            async with httpx.AsyncClient(timeout=10, headers=BROWSER_HEADERS) as client:
                resp = await client.get(
                    MAIL_API,
                    params={
                        "action": "readMessage",
                        "login": username,
                        "domain": domain,
                        "id": int(msg_id),
                    },
                )
                resp.raise_for_status()
                msg = resp.json()

            # Sanitize both HTML and plain-text body fields
            if msg.get("htmlBody"):
                msg["htmlBody"] = sanitize_html(msg["htmlBody"])
            if msg.get("body"):
                # Plain text — escape just in case it gets rendered
                msg["body"] = bleach.clean(msg["body"], tags=[], strip=True)

            logger.info(f"Served message {msg_id} for {username}@{domain}")
            return msg

        except HTTPException:
            raise
        except Exception as exc:
            logger.error(f"1secmail fetch message error: {exc}")
            raise HTTPException(status_code=502, detail="Failed to fetch message.")
