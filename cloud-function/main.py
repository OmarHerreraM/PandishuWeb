"""
Pandishu B2B Lead Form → Telegram Notification
Cloud Function (Python 3.12) — HTTP trigger with CORS

Deployment:
    gcloud functions deploy contact_form \
        --gen2 \
        --runtime python312 \
        --trigger-http \
        --allow-unauthenticated \
        --region us-central1 \
        --memory 256MB \
        --timeout 30s \
        --set-env-vars TELEGRAM_BOT_TOKEN=xxx,TELEGRAM_CHAT_ID=xxx \
        --source .
"""

import os
import json
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

import functions_framework

# ─── Config ──────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

ALLOWED_ORIGINS = [
    "https://www.pandishu.com",
    "https://pandishu.com",
    "https://pandishu-web-1d860.web.app",
    "https://pandishu-web-1d860.firebaseapp.com",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
]


def _cors_headers(origin: str) -> dict:
    """Return CORS headers. Uses wildcard * for public form endpoint."""
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "3600",
    }


def _escape_md(text: str) -> str:
    """Escape Markdown v1 special characters for Telegram."""
    for ch in ('_', '*', '`', '['):
        text = text.replace(ch, '\\' + ch)
    return text


def _send_telegram(text: str) -> dict:
    """Send message via Telegram Bot API. Returns {"ok": bool, "detail": str}."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        msg = (
            f"TELEGRAM CONFIG MISSING — "
            f"TOKEN={'SET' if TELEGRAM_BOT_TOKEN else 'EMPTY'}, "
            f"CHAT_ID={'SET' if TELEGRAM_CHAT_ID else 'EMPTY'}"
        )
        print(f"ERROR: {msg}")
        return {"ok": False, "detail": msg}

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "Markdown",
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            print(f"Telegram API {resp.status}: {body}")
            if resp.status == 200:
                return {"ok": True, "detail": "sent"}
            return {"ok": False, "detail": f"HTTP {resp.status}: {body}"}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        print(f"ERROR Telegram HTTP {e.code}: {error_body}")
        return {"ok": False, "detail": f"HTTP {e.code}: {error_body}"}
    except Exception as e:
        print(f"ERROR Telegram exception: {e}")
        return {"ok": False, "detail": str(e)}


@functions_framework.http
def contact_form(request):
    """HTTP Cloud Function entry point."""

    origin = request.headers.get("Origin", "")
    headers = _cors_headers(origin)

    # ── Preflight ────────────────────────────────────────────────────────
    if request.method == "OPTIONS":
        return ("", 204, headers)

    # ── Only POST ────────────────────────────────────────────────────────
    if request.method != "POST":
        return (json.dumps({"error": "Method not allowed"}), 405, headers)

    # ── Parse body ───────────────────────────────────────────────────────
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        return (json.dumps({"error": "Invalid JSON"}), 400, headers)

    nombre = (data.get("nombre") or "").strip()
    empresa = (data.get("empresa") or "").strip()
    email = (data.get("email") or "").strip()
    telefono = (data.get("telefono") or "").strip()
    mensaje = (data.get("mensaje") or "").strip()

    # ── Validate required fields ─────────────────────────────────────────
    if not nombre or not email or not telefono or not mensaje:
        return (
            json.dumps({"error": "Campos obligatorios: nombre, email, telefono, mensaje."}),
            400,
            headers,
        )

    # ── Basic email format check ─────────────────────────────────────────
    if "@" not in email or "." not in email.split("@")[-1]:
        return (json.dumps({"error": "Email invalido."}), 400, headers)

    # ── Build Telegram message ───────────────────────────────────────────
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    tg_text = (
        f"🔔 *NUEVO LEAD B2B — PANDISHU*\n"
        f"\n"
        f"👤 *Nombre:* {_escape_md(nombre)}\n"
        f"🏢 *Empresa:* {_escape_md(empresa) or 'No indicada'}\n"
        f"📧 *Email:* {_escape_md(email)}\n"
        f"📱 *Tel:* {_escape_md(telefono)}\n"
        f"\n"
        f"📝 *Proyecto:*\n{_escape_md(mensaje)}\n"
        f"\n"
        f"🕐 {ts}"
    )

    result = _send_telegram(tg_text)

    # ── Response ─────────────────────────────────────────────────────────
    if not result["ok"]:
        print(f"LEAD LOST — {nombre} / {email} — Telegram failed: {result['detail']}")
        return (
            json.dumps({
                "success": False,
                "error": "No se pudo enviar la notificación. Intenta de nuevo o escríbenos por WhatsApp.",
            }),
            500,
            headers,
        )

    return (
        json.dumps({
            "success": True,
            "message": "Solicitud recibida. Te contactaremos pronto.",
        }),
        200,
        headers,
    )
