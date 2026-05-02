// ==UserScript==
// @name         StreetMusic Ufa WhatsApp booking watcher
// @namespace    https://streetmusic-ufa.local/
// @version      0.1.5
// @description  Watches WhatsApp Web messages and sends booking-like messages to StreetMusic Ufa Google Apps Script.
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    apiUrl: "https://script.google.com/macros/s/AKfycbzqBWxUthTdOt09gBxesmhghlBD927fm7glmh2xy5cERx5tz-fHTlQ5O4C1x0S77JHt/exec",
    processExistingOnStart: false,
    scanIntervalMs: 2000,
    debug: true,
    /** Подробные логи: почему сообщение пропущено (шумнее консоль) */
    debugVerbose: false,

    /**
     * Отладка: при загрузке чата несколько раз просканировать уже видимые сообщения
     * только за сегодня (по дате в data-pre-plain-text, часовой пояс Уфы).
     * После проверки поставьте false, чтобы не гонять API при каждом F5.
     */
    debugBackfillToday: false,
    /** Перед догоном очистить seen — иначе уже обработанные сегодняшние не отправятся повторно */
    debugBackfillTodayClearSeen: false,
    /** Задержки (мс) после старта: WhatsApp подгружает пузыри не сразу */
    debugBackfillDelaysMs: [2500, 7000, 15000],

    /**
     * Если true — и периодический опрос (каждые scanIntervalMs) шлёт только сообщения
     * с датой пузыря = сегодня по Уфе. Иначе при прокрутке истории уйдут брони за вчера.
     */
    onlySendIfChatDateIsTodayUfa: true
  };

  const seen = new Set(JSON.parse(sessionStorage.getItem("streetmusic-wa-seen") || "[]"));

  function saveSeen() {
    sessionStorage.setItem("streetmusic-wa-seen", JSON.stringify([...seen].slice(-1000)));
  }

  function parsePlainText(value) {
    const match = String(value || "").match(/^\[(\d{1,2}:\d{2}),\s*(\d{1,2}[./]\d{1,2}[./]\d{4})\]\s*(.*?):\s*$/);
    if (!match) return null;

    return {
      chatTime: match[1],
      chatDate: match[2],
      phoneLast4: getPhoneLast4(match[3])
    };
  }

  function getMessageText(node) {
    const textNode = node.querySelector(".selectable-text") || node;
    return String(textNode.innerText || textNode.textContent || "")
      .replace(/\u200e/g, "")
      .trim();
  }

  function getPhoneLast4(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : "";
  }

  function logVerbose(reason, detail) {
    if (!CONFIG.debugVerbose) return;
    console.log("[StreetMusic WA skip]", reason, detail || "");
  }

  /** Сегодня по календарю Уфы (как на сайте) */
  function ufaTodayIso() {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Yekaterinburg",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = {};
    formatter.formatToParts(new Date()).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  /** DD.MM.YYYY из WhatsApp → yyyy-MM-dd */
  function chatDateToIso(chatDate) {
    const match = String(chatDate || "")
      .trim()
      .match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    if (!match) return "";
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (!day || !month || !year) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function isChatDateTodayUfa(chatDate) {
    return chatDateToIso(chatDate) === ufaTodayIso();
  }

  function privacyHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function getMessageId(meta, message) {
    return [
      meta.phoneLast4,
      meta.chatDate,
      meta.chatTime,
      privacyHash(message)
    ].join("|");
  }

  function isLikelyBookingText(message) {
    const text = message.toLowerCase().replace(/ё/g, "е");
    const hasTime =
      /\b\d{1,2}\s*[:.]\s*\d{2}\b/.test(text) ||
      /\d{1,2}\s*\.\s*\d{2}\s*[-—]\s*\d{1,2}/.test(text) ||
      /(^|[\s,.;:])(в|с)\s*\d{1,2}(?=\D|$)/.test(text);
    const hasPlaceOrIntent =
      /(встан|встаю|встал|брон|заним|отмена|снимаю|форс|семь|семью|семье|горс|больш|мал|цр|спортив|бульвар|аграрн|монумент|юнош|библиотек)/.test(text);
    return hasTime && hasPlaceOrIntent;
  }

  function sanitizeMessageForApi(message) {
    return String(message || "")
      .replace(/\+?\d[\d\s().-]{6,}\d/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function postBooking(payload) {
    const body = JSON.stringify({ action: "whatsappBooking", ...payload });

    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: "POST",
        url: CONFIG.apiUrl,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        data: body,
        onload: (response) => {
          if (CONFIG.debug) {
            console.log("[StreetMusic WA]", response.status, response.responseText);
          }
        },
        onerror: (error) => console.warn("[StreetMusic WA] request failed", error)
      });
      return;
    }

    fetch(CONFIG.apiUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body
    }).catch((error) => console.warn("[StreetMusic WA] request failed", error));
  }

  function findMessageRoot(node) {
    if (!(node instanceof Element)) return null;
    if (node.hasAttribute("data-pre-plain-text")) return node;
    const closest = node.closest("[data-pre-plain-text]");
    return closest || null;
  }

  function processMessageNode(node, shouldSend, options) {
    const opts = options || {};
    if (!(node instanceof Element)) return;

    const root = findMessageRoot(node);
    if (!root) {
      logVerbose("no data-pre-plain-text", node.className);
      return;
    }

    const plain = root.getAttribute("data-pre-plain-text");
    const meta = parsePlainText(plain);
    if (!meta) {
      logVerbose("parsePlainText failed", plain && plain.slice(0, 80));
      return;
    }

    const requireToday = Boolean(opts.requireToday) || Boolean(CONFIG.onlySendIfChatDateIsTodayUfa);
    if (requireToday && !isChatDateTodayUfa(meta.chatDate)) {
      logVerbose("not today (Ufa)", meta.chatDate);
      return;
    }

    const message = getMessageText(root);
    if (!message) {
      logVerbose("empty message text", "");
      return;
    }
    if (!meta.phoneLast4) {
      logVerbose("phoneLast4 missing", "");
      return;
    }

    const messageId = getMessageId(meta, message);
    if (seen.has(messageId)) return;

    seen.add(messageId);
    saveSeen();

    if (!shouldSend) return;

    if (!isLikelyBookingText(message)) {
      if (CONFIG.debug) {
        console.log("[StreetMusic WA] ignored (not booking-like):", messageId);
      }
      return;
    }

    if (CONFIG.debug) {
      console.log("[StreetMusic WA] sending:", messageId);
    }

    const messageForApi = sanitizeMessageForApi(message);
    if (!messageForApi) return;

    postBooking({
      phoneLast4: meta.phoneLast4,
      chatDate: meta.chatDate,
      chatTime: meta.chatTime,
      message: messageForApi,
      messageId
    });
  }

  function scanExisting(shouldSend, options) {
    document
      .querySelectorAll("[data-pre-plain-text]")
      .forEach((node) => processMessageNode(node, shouldSend, options));
  }

  function clearSeenForDebug() {
    seen.clear();
    try {
      sessionStorage.removeItem("streetmusic-wa-seen");
    } catch (e) {
      /* ignore */
    }
    if (CONFIG.debug) console.log("[StreetMusic WA] seen очищен для догона за сегодня");
  }

  /** Одноразовый проход: видимые пузыри только за сегодня (Уфа), как при отладке */
  function scanBackfillToday() {
    if (CONFIG.debug) {
      console.log("[StreetMusic WA] backfill за сегодня (Уфа):", ufaTodayIso(), "узлов:", document.querySelectorAll("[data-pre-plain-text]").length);
    }
    scanExisting(true, { requireToday: true });
  }

  function scheduleDebugBackfillToday() {
    if (!CONFIG.debugBackfillToday) return;

    if (CONFIG.debugBackfillTodayClearSeen) {
      clearSeenForDebug();
    }

    const delays = Array.isArray(CONFIG.debugBackfillDelaysMs) ? CONFIG.debugBackfillDelaysMs : [3000];
    delays.forEach((delayMs) => {
      window.setTimeout(() => scanBackfillToday(), delayMs);
    });
  }

  function startObserver() {
    scanExisting(CONFIG.processExistingOnStart);

    scheduleDebugBackfillToday();

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          processMessageNode(node, true, {});
          node.querySelectorAll("[data-pre-plain-text]").forEach((messageNode) => {
            processMessageNode(messageNode, true, {});
          });
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.setInterval(() => scanExisting(true, {}), CONFIG.scanIntervalMs);
    console.log("[StreetMusic WA] watcher started; сегодня (Уфа):", ufaTodayIso());
    console.log("[StreetMusic WA] вручную догон: streetMusicWaBackfillToday()");
  }

  if (typeof unsafeWindow !== "undefined") {
    unsafeWindow.streetMusicWaBackfillToday = function streetMusicWaBackfillToday() {
      clearSeenForDebug();
      scanBackfillToday();
    };
    unsafeWindow.streetMusicWaUfaToday = ufaTodayIso;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
