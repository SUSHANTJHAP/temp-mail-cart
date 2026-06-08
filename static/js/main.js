/**
 * TempMail Cart — Frontend Engine
 * Handles: email generation, inbox polling (7s), modal viewer, clipboard, FAQ
 */

"use strict";

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  username: null,
  domain: null,
  email: null,
  pollingTimer: null,
  countdownTimer: null,
  seenIds: new Set(),
  pollInterval: 3,        // seconds
  countdownLeft: 3,
};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const elEmail        = $("email-display");
const elCopyBtn      = $("btn-copy");
const elRefreshBtn   = $("btn-refresh");
const elInboxList    = $("inbox-list");
const elInboxEmpty   = $("inbox-empty");
const elInboxCount   = $("inbox-count");
const elCountdown    = $("countdown-timer");
const elModal        = $("email-modal");
const elModalClose   = $("modal-close");
const elModalFrom    = $("modal-from");
const elModalSubject = $("modal-subject");
const elModalDate    = $("modal-date");
const elModalBody    = $("modal-body-content");
const elStatusDot    = $("status-dot");
const elStatusText   = $("status-text");
const elToast        = $("toast");
const elRefreshInboxBtn = $("btn-refresh-inbox");

// ── Utility ────────────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  elToast.textContent = "✓ " + msg;
  elToast.style.background = isError
    ? "rgba(239,68,68,0.95)"
    : "rgba(16,185,129,0.95)";
  elToast.classList.add("show");
  setTimeout(() => elToast.classList.remove("show"), 2800);
}

function setStatus(active, text) {
  elStatusDot.style.background = active ? "var(--success)" : "var(--warning)";
  elStatusText.textContent = text;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return dateStr; }
}

function truncate(str, n) {
  if (!str) return "(no subject)";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

async function copyText(text, toastMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(toastMsg);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast(toastMsg);
  }
}

function extractOTP(subject, body) {
  const text = (subject || "") + " " + (body || "");
  if (!text.trim()) return null;
  const cleanText = text.replace(/<[^>]*>/g, " ");
  const keywordRegex = /(?:code|otp|pin|verification|one-time|verification\s*code|auth|verification-code|passcode)\b[^.!?]{0,30}?(\b\d{4,8}\b)/i;
  const keywordMatch = cleanText.match(keywordRegex);
  if (keywordMatch && keywordMatch[1]) {
    return keywordMatch[1];
  }
  const generalRegex = /\b\d{4,8}\b/g;
  const matches = cleanText.match(generalRegex);
  if (matches) {
    for (const match of matches) {
      const num = parseInt(match, 10);
      if (match.length === 4 && num >= 1900 && num <= 2100) {
        continue;
      }
      return match;
    }
  }
  return null;
}

// ── Loading States ─────────────────────────────────────────────────────────────
function setRefreshLoading(on) {
  elRefreshBtn.disabled = on;
  elRefreshBtn.innerHTML = on
    ? `<span class="spinner"></span> Generating…`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> New Email`;
}

function setInboxRefreshLoading(on) {
  if (!elRefreshInboxBtn) return;
  elRefreshInboxBtn.disabled = on;
  if (on) {
    elRefreshInboxBtn.innerHTML = `<span class="spinner"></span> Refreshing…`;
  } else {
    elRefreshInboxBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Refresh`;
  }
}

// ── Countdown ──────────────────────────────────────────────────────────────────
function startCountdown() {
  state.countdownLeft = state.pollInterval;
  elCountdown.textContent = state.countdownLeft + "s";
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    state.countdownLeft = Math.max(0, state.countdownLeft - 1);
    elCountdown.textContent = state.countdownLeft + "s";
  }, 1000);
}

// ── Polling ────────────────────────────────────────────────────────────────────
function startPolling() {
  clearInterval(state.pollingTimer);
  startCountdown();
  state.pollingTimer = setInterval(async () => {
    await checkInbox(false);
    startCountdown();
  }, state.pollInterval * 1000);
}

function stopPolling() {
  clearInterval(state.pollingTimer);
  clearInterval(state.countdownTimer);
  state.pollingTimer = null;
}

// ── API Calls ──────────────────────────────────────────────────────────────────
async function generateEmail() {
  stopPolling();
  setRefreshLoading(true);
  setStatus(false, "Generating…");
  elEmail.textContent = "Generating your address…";
  elInboxList.innerHTML = "";
  elInboxEmpty.style.display = "block";
  elInboxCount.textContent = "0";
  state.seenIds.clear();

  try {
    const res = await fetch("/api/new-email");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.username = data.username;
    state.domain   = data.domain;
    state.email    = data.email;
    elEmail.textContent = data.email;
    setStatus(true, "Auto-checking inbox…");
    startPolling();
    showToast("New disposable address ready!");
  } catch (err) {
    console.error(err);
    elEmail.textContent = "Error — please try again";
    setStatus(false, "Connection error");
    showToast("Failed to generate address", true);
  } finally {
    setRefreshLoading(false);
  }
}

async function checkInbox(showFeedback = false) {
  if (!state.username || !state.domain) return;
  try {
    const res = await fetch(`/api/check-inbox/${state.username}/${state.domain}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const messages = data.messages || [];
    renderInbox(messages);
    if (showFeedback) showToast(`Inbox refreshed — ${messages.length} message(s)`);
  } catch (err) {
    console.error("Inbox poll error:", err);
  }
}

async function openMessage(id) {
  if (!state.username || !state.domain) return;
  try {
    elModalBody.innerHTML = `<div style="text-align:center;padding:40px"><div class="spinner" style="margin:auto;width:32px;height:32px"></div><p style="margin-top:16px;color:var(--text-muted)">Loading message…</p></div>`;
    elModal.classList.add("active");
    document.body.style.overflow = "hidden";

    const res = await fetch(`/api/message/${state.username}/${state.domain}/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const msg = await res.json();

    elModalFrom.textContent    = msg.from || "Unknown Sender";
    elModalSubject.textContent = msg.subject || "(No Subject)";
    elModalDate.textContent    = formatDate(msg.date);

    // Scan subject and body for OTP
    const otp = extractOTP(msg.subject, msg.htmlBody || msg.body);
    let otpBannerHtml = "";
    if (otp) {
      otpBannerHtml = `
        <div class="otp-modal-banner" style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:12px;padding:12px 16px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div style="display:flex;align-items:center;gap:8px">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span style="font-size:0.85rem;color:var(--text-primary);font-weight:600">
              One-Time Password (OTP) detected: <strong style="color:var(--success);font-family:'JetBrains Mono',monospace;font-size:1.05rem;margin-left:4px;letter-spacing:0.5px">${otp}</strong>
            </span>
          </div>
          <button class="btn-otp-copy-modal" data-otp="${otp}">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy Code
          </button>
        </div>
      `;
    }

    // Render sanitized HTML or plain text
    const content = msg.htmlBody || msg.body || "(Empty message)";
    if (msg.htmlBody) {
      elModalBody.innerHTML = `${otpBannerHtml}<div class="email-html-body">${content}</div>`;
    } else {
      elModalBody.innerHTML = `${otpBannerHtml}<pre style="white-space:pre-wrap;font-family:inherit;color:var(--text-secondary);line-height:1.7">${content}</pre>`;
    }

    const btnModalCopy = elModalBody.querySelector(".btn-otp-copy-modal");
    if (btnModalCopy) {
      btnModalCopy.addEventListener("click", () => {
        copyText(otp, "OTP copied: " + otp);
      });
    }
  } catch (err) {
    console.error(err);
    elModalBody.innerHTML = `<p style="color:var(--danger);text-align:center">Failed to load message. Please try again.</p>`;
  }
}

// ── Inbox Renderer ─────────────────────────────────────────────────────────────
function renderInbox(messages) {
  elInboxCount.textContent = messages.length;

  if (messages.length === 0) {
    elInboxList.innerHTML = "";
    elInboxEmpty.style.display = "block";
    return;
  }

  elInboxEmpty.style.display = "none";
  // Sort newest first
  const sorted = [...messages].sort((a, b) => new Date(b.date) - new Date(a.date));

  sorted.forEach((msg) => {
    const existing = document.getElementById(`msg-${msg.id}`);
    if (existing) return;   // already in DOM

    const isNew = !state.seenIds.has(msg.id);
    state.seenIds.add(msg.id);

    const otp = extractOTP(msg.subject, null);

    const item = document.createElement("div");
    item.id = `msg-${msg.id}`;
    item.className = `inbox-item${isNew ? " unread" : ""}`;
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", `Email from ${msg.from}, subject: ${msg.subject}`);
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-weight:600;font-size:0.85rem;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escHtml(truncate(msg.from || "Unknown", 40))}
        </span>
        <span style="font-size:0.72rem;color:var(--text-muted);white-space:nowrap;flex-shrink:0">
          ${formatDate(msg.date)}
        </span>
      </div>
      <div style="font-size:0.82rem;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px">
        ${escHtml(truncate(msg.subject || "(No Subject)", 60))}
      </div>
      <div class="flex items-center justify-between flex-wrap gap-2 mt-2" id="msg-actions-${msg.id}">
        <div class="flex gap-2" id="msg-badges-${msg.id}">
          ${isNew ? '<span style="font-size:0.65rem;background:rgba(34,211,238,0.15);color:var(--accent);padding:2px 8px;border-radius:10px;font-weight:600">NEW</span>' : ""}
          ${otp ? '<span style="font-size:0.65rem;background:rgba(16,185,129,0.15);color:var(--success);padding:2px 8px;border-radius:10px;font-weight:600">OTP</span>' : ""}
        </div>
        ${otp ? `
          <button class="btn-otp-copy-inbox" data-otp="${otp}" aria-label="Copy OTP ${otp}">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy Code (${otp})
          </button>
        ` : ""}
      </div>
    `;

    item.addEventListener("click", () => openMessage(msg.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openMessage(msg.id);
    });

    const btnCopy = item.querySelector(".btn-otp-copy-inbox");
    if (btnCopy) {
      btnCopy.addEventListener("click", (e) => {
        e.stopPropagation();
        const otpCode = btnCopy.getAttribute("data-otp");
        copyText(otpCode, "OTP copied: " + otpCode);
      });
    }

    // Prepend new items to top
    elInboxList.prepend(item);

    // If we didn't find an OTP in the subject, fetch the body in the background
    if (isNew && !otp) {
      setTimeout(() => {
        fetch(`/api/message/${state.username}/${state.domain}/${msg.id}`)
          .then(res => res.ok ? res.json() : null)
          .then(fullMsg => {
            if (fullMsg) {
               const bodyOtp = extractOTP(fullMsg.subject, fullMsg.htmlBody || fullMsg.body);
               if (bodyOtp) {
                 const badgesDiv = document.getElementById(`msg-badges-${msg.id}`);
                 const actionsDiv = document.getElementById(`msg-actions-${msg.id}`);
                 if (badgesDiv && actionsDiv) {
                   badgesDiv.insertAdjacentHTML('beforeend', '<span style="font-size:0.65rem;background:rgba(16,185,129,0.15);color:var(--success);padding:2px 8px;border-radius:10px;font-weight:600">OTP</span>');
                   const btn = document.createElement("button");
                   btn.className = "btn-otp-copy-inbox";
                   btn.setAttribute("data-otp", bodyOtp);
                   btn.setAttribute("aria-label", "Copy OTP " + bodyOtp);
                   btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy Code (${bodyOtp})`;
                   btn.addEventListener("click", (e) => {
                     e.stopPropagation();
                     copyText(bodyOtp, "OTP copied: " + bodyOtp);
                   });
                   actionsDiv.appendChild(btn);
                 }
               }
            }
          }).catch(err => console.error("Background OTP fetch failed:", err));
      }, 1200); // 1.2s delay to avoid 1secmail/catchmail rate limit (1 request/sec)
    }
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Modal ──────────────────────────────────────────────────────────────────────
function closeModal() {
  elModal.classList.remove("active");
  document.body.style.overflow = "";
}

elModalClose.addEventListener("click", closeModal);
elModal.addEventListener("click", (e) => {
  if (e.target === elModal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ── Clipboard ──────────────────────────────────────────────────────────────────
elCopyBtn.addEventListener("click", async () => {
  if (!state.email) {
    showToast("Generate an email address first", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(state.email);
    elCopyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
    showToast("Email copied to clipboard!");
    setTimeout(() => {
      elCopyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy`;
    }, 2000);
  } catch {
    // Fallback for older browsers
    const ta = document.createElement("textarea");
    ta.value = state.email;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("Email copied!");
  }
});

// ── Refresh button ─────────────────────────────────────────────────────────────
elRefreshBtn.addEventListener("click", generateEmail);

// ── Refresh inbox button ───────────────────────────────────────────────────────
if (elRefreshInboxBtn) {
  elRefreshInboxBtn.addEventListener("click", async () => {
    if (!state.email) {
      showToast("Generate an email address first", true);
      return;
    }
    setInboxRefreshLoading(true);
    const startTime = Date.now();
    await checkInbox(true);
    
    // Ensure the loading animation displays for at least 800ms to give a satisfying feel
    const elapsedTime = Date.now() - startTime;
    const minDelay = 800;
    if (elapsedTime < minDelay) {
      await new Promise(resolve => setTimeout(resolve, minDelay - elapsedTime));
    }
    
    startPolling();
    setInboxRefreshLoading(false);
  });
}

// ── FAQ Accordion ──────────────────────────────────────────────────────────────
document.querySelectorAll(".faq-item").forEach((item) => {
  const question = item.querySelector(".faq-question");
  question.addEventListener("click", () => {
    const isOpen = item.classList.contains("open");
    document.querySelectorAll(".faq-item.open").forEach((el) => el.classList.remove("open"));
    if (!isOpen) item.classList.add("open");
  });
});

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  generateEmail();
});
