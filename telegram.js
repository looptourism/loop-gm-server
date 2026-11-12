// ---------------------------------------------------------------------------
// Telegram — a thin client for the Bot API plus the webhook plumbing.
//
// The bot token is part of every Bot API URL, so nothing in here ever logs a
// URL, and every error message is passed through redact() before it leaves
// this file. Nothing else in the codebase needs to read the token.
// ---------------------------------------------------------------------------
const crypto = require("crypto");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
const WEBHOOK_PATH = "/api/telegram/webhook";

const enabled = !!(TOKEN && CHAT_ID);

function redact(text) {
  let out = String(text ?? "");
  if (TOKEN) out = out.split(TOKEN).join("[redacted]");
  if (WEBHOOK_SECRET) out = out.split(WEBHOOK_SECRET).join("[redacted]");
  return out;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Current time in the UAE, e.g. "11/11/2026، 9:42 م"
function uaeTime(date = new Date()) {
  return date.toLocaleString("ar-AE", {
    timeZone: "Asia/Dubai", day: "numeric", month: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

async function api(method, params = {}) {
  if (!TOKEN) throw new Error("telegram: TELEGRAM_BOT_TOKEN is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      throw new Error(`telegram ${method} failed: ${res.status} ${data?.description || ""}`.trim());
    }
    return data.result;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`telegram ${method} timed out`);
    throw new Error(redact(e.message));
  } finally {
    clearTimeout(timer);
  }
}

function sendMessage(text, extra = {}) {
  return api("sendMessage", { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

function editMessageText(messageId, text, extra = {}) {
  return api("editMessageText", { chat_id: CHAT_ID, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

function answerCallbackQuery(id, text) {
  return api("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

// Points Telegram at our webhook (with the shared secret), then logs what
// Telegram itself reports back. The webhook URL contains no credentials.
async function registerWebhook(publicUrl) {
  if (!enabled) {
    console.log("[telegram] disabled — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
    return false;
  }
  if (!WEBHOOK_SECRET) {
    console.error("[telegram] TELEGRAM_WEBHOOK_SECRET not set — webhook not registered (it would reject every update)");
    return false;
  }
  if (!publicUrl) {
    console.error("[telegram] no public URL (set PUBLIC_URL) — webhook not registered");
    return false;
  }
  const url = publicUrl.replace(/\/+$/, "") + WEBHOOK_PATH;
  try {
    await api("setWebhook", { url, secret_token: WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
    const info = await api("getWebhookInfo");
    console.log("[telegram] getWebhookInfo:", redact(JSON.stringify({
      url: info.url,
      pending_update_count: info.pending_update_count,
      last_error_date: info.last_error_date,
      last_error_message: info.last_error_message,
      max_connections: info.max_connections,
      allowed_updates: info.allowed_updates,
      ip_address: info.ip_address,
    })));
    return info.url === url;
  } catch (e) {
    console.error("[telegram] webhook registration failed:", redact(e.message));
    return false;
  }
}

// True only when the request carries the exact secret we registered with
// setWebhook. With no secret configured, nothing is accepted.
function isAuthenticWebhook(req) {
  if (!WEBHOOK_SECRET) return false;
  const got = Buffer.from(String(req.get("X-Telegram-Bot-Api-Secret-Token") || ""));
  const want = Buffer.from(WEBHOOK_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// True only for updates that come from the owner's chat.
function isFromOwnerChat(update) {
  const chat = update?.callback_query?.message?.chat || update?.message?.chat;
  return !!chat && String(chat.id) === CHAT_ID;
}

module.exports = {
  enabled, WEBHOOK_PATH,
  redact, escapeHtml, uaeTime,
  sendMessage, editMessageText, answerCallbackQuery,
  registerWebhook, isAuthenticWebhook, isFromOwnerChat,
};
