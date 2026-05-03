// ==UserScript==
// @name         StreetMusic Ufa WhatsApp booking watcher
// @namespace    https://streetmusic-ufa.local/
// @version      0.1.13
// @description  Watches WhatsApp Web messages and sends booking-like messages to StreetMusic Ufa Google Apps Script.
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_VERSION = "0.1.13";

  const CONFIG = {
    apiUrl: "https://script.google.com/macros/s/AKfycbzqBWxUthTdOt09gBxesmhghlBD927fm7glmh2xy5cERx5tz-fHTlQ5O4C1x0S77JHt/exec",
    processExistingOnStart: false,
    scanIntervalMs: 2000,
    debug: true,
    /** Подробные логи: почему сообщение пропущено (шумнее консоль) */
    debugVerbose: false,
    /**
     * При debug: в консоль — поле message, которое реально уходит в POST (после sanitize).
     * Номера в тексте вырезаются; phoneLast4 в логе — только суффикс из настроек WA.
     */
    debugLogApiMessage: true,

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

  const CONTACT_PHONE_LAST4_BY_NAME = {
    "сергей король": "4779"
  };

  const TRANSITION_ALIASES = [
    { label: "Юношеская библиотека", aliases: ["юношеская библиотека", "юн библ"] },
    { label: "Большой ЦР", aliases: ["большой цр", "цр большой", "большой", "большом"] },
    { label: "Малый ЦР", aliases: ["малый цр", "цр малый", "малый", "малом"] },
    { label: "Бульвар Славы", aliases: ["бульвар славы", "бульвар"] },
    { label: "Спортивная", aliases: ["спортивная", "спортивной", "спортивную", "спорт"] },
    { label: "Аграрный", aliases: ["аграрный", "аграрка", "аграрке", "аграрн"] },
    { label: "Горсовет", aliases: ["горсовет", "горс"] },
    { label: "Семья", aliases: ["семья", "семье", "семью"] }
  ];

  function saveSeen() {
    sessionStorage.setItem("streetmusic-wa-seen", JSON.stringify([...seen].slice(-1000)));
  }

  function parsePlainText(value) {
    const match = String(value || "").match(/^\[(\d{1,2}:\d{2}),\s*(\d{1,2}[./]\d{1,2}[./]\d{4})\]\s*(.*?):\s*$/);
    if (!match) return null;
    const sender = match[3];

    return {
      chatTime: match[1],
      chatDate: match[2],
      phoneLast4: getPhoneLast4(sender) || getPhoneLast4ByContactName(sender)
    };
  }

  function getMessageText(node) {
    const textNode = node.querySelector(".selectable-text") || node;
    return String(textNode.innerText || textNode.textContent || "")
      .replace(/\u200e/g, "")
      .trim();
  }

  function getMessageParts(node) {
    const quotedReply = node.querySelector("[data-testid='quoted-message'], [aria-label*='Цитируемое'], [aria-label*='Quoted']");
    let quotedMessage = "";
    if (quotedReply) {
      quotedMessage = getMessageText(quotedReply);
      quotedReply.remove();
    }

    const rawText = getMessageText(node);
    const fallback = !quotedMessage ? splitLikelyQuotedReplyText(rawText) : null;
    const answerMessage = fallback ? fallback.message : stripLikelyQuotedReplyText(rawText);
    const quoteText = quotedMessage || (fallback ? fallback.quotedMessage : "");
    const derivedMessage =
      deriveCancellationReplyMessage(answerMessage, quoteText) ||
      deriveFollowUpReplyMessage(answerMessage, quoteText);

    return {
      message: derivedMessage || answerMessage,
      answerMessage,
      quotedMessage: quoteText
    };
  }

  function getMessageTextWithoutQuotedReply(node) {
    return getMessageParts(node).message;
  }

  function stripLikelyQuotedReplyText(text) {
    const parts = splitLikelyQuotedReplyText(text);
    if (parts) return parts.message;
    return String(text || "").trim();
  }

  function splitLikelyQuotedReplyText(text) {
    const lines = String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) return null;

    const lastLine = lines[lines.length - 1];
    const quotedLines = lines.slice(0, -1);
    const hasQuotedContactLine = lines
      .slice(0, -1)
      .some((line) => /^~?\s*[\p{L}\p{N} ._-]{2,}(?:\s+\d{4})?$|^\+?\d[\d\s().-]{6,}\d$/u.test(line));
    const previousTextLooksBooking = lines
      .slice(0, -1)
      .some((line) => isLikelyBookingText(line));
    const answerLooksRelevant = isLikelyBookingText(lastLine) || hasCancellationIntent(lastLine) || (hasFollowUpIntent(lastLine) && findTransitionMention(lastLine));

    if (hasQuotedContactLine && previousTextLooksBooking && answerLooksRelevant) {
      return {
        message: lastLine,
        quotedMessage: quotedLines.join("\n")
      };
    }

    return null;
  }

  function getPhoneLast4(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : "";
  }

  function getPhoneLast4ByContactName(value) {
    const normalized = normalizeContactName(value);
    const keys = Object.keys(CONTACT_PHONE_LAST4_BY_NAME)
      .sort((first, second) => second.length - first.length);
    for (let index = 0; index < keys.length; index += 1) {
      const key = normalizeContactName(keys[index]);
      if (normalized.includes(key)) return CONTACT_PHONE_LAST4_BY_NAME[keys[index]];
    }
    return "";
  }

  function normalizeContactName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeRu(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s:.—-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeRegexp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function containsWordPhrase(text, phrase) {
    const escaped = escapeRegexp(phrase).replace(/\s+/g, "\\s+");
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(text);
  }

  function findTransitionMention(text) {
    const normalized = normalizeRu(text);
    const aliases = TRANSITION_ALIASES
      .flatMap((transition) => transition.aliases.map((alias) => ({ label: transition.label, alias })))
      .sort((first, second) => second.alias.length - first.alias.length);

    for (let index = 0; index < aliases.length; index += 1) {
      const item = aliases[index];
      if (containsWordPhrase(normalized, item.alias)) return item;
    }

    return null;
  }

  function hasFollowUpIntent(text) {
    const normalized = normalizeRu(text);
    return /(^|\s)(после\s+(вас|тебя|него|нее|них)|за\s+(вами|тобой|ним|ней|ними)|следом)(?=\s|$)/.test(normalized);
  }

  function hasCancellationIntent(text) {
    return /(^|\s)(отмена|отменяю|снимаю|снять|форс)(?=\s|$)/.test(normalizeRu(text));
  }

  function hasExplicitBookingTime(text) {
    const normalized = normalizeRu(text);
    return /\b\d{1,2}\s*[:.]\s*\d{2}\b/.test(normalized) ||
      /(^|[\s,.;:])(в|с|c)\s*\d{1,2}(?=\D|$)/.test(normalized);
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
    const hasKnownPlace =
      /(семь|семью|семье|горс|больш|мал|цр|спортив|бульвар|аграрн|аграрк|юнош|библиотек)/.test(text);
    const hasTime =
      /\b\d{1,2}\s*[:.]\s*\d{2}\b/.test(text) ||
      /\d{1,2}\s*\.\s*\d{2}\s*[-—]\s*\d{1,2}/.test(text) ||
      /(^|[\s,.;:])(в|с)\s*\d{1,2}(?=\D|$)/.test(text) ||
      (hasKnownPlace && /(^|\D)\d{1,2}(?=\D|$)/.test(text));
    const hasPlaceOrIntent =
      hasKnownPlace || /(встан|встаю|встал|брон|заним|отмена|снимаю|форс)/.test(text);
    return hasTime && hasPlaceOrIntent;
  }

  function deriveFollowUpReplyMessage(answerMessage, quotedMessage) {
    const answer = stripWhatsAppWebTimeGlue(String(answerMessage || "")).trim();
    const quote = stripWhatsAppWebTimeGlue(String(quotedMessage || "")).trim();
    if (!answer || !quote) return "";
    if (!hasFollowUpIntent(answer) || hasExplicitBookingTime(answer)) return "";

    const transition = findTransitionMention(answer);
    if (!transition) return "";

    const quotedRange = extractQuotedRangeForTransition(quote, transition.label);
    if (!quotedRange) return "";

    return `${transition.label} в ${quotedRange.endTime} встану`;
  }

  function deriveCancellationReplyMessage(answerMessage, quotedMessage) {
    const answer = stripWhatsAppWebTimeGlue(String(answerMessage || "")).trim();
    const quote = stripWhatsAppWebTimeGlue(String(quotedMessage || "")).trim();
    if (!answer || !quote || !hasCancellationIntent(answer)) return "";

    const explicitTransition = findTransitionMention(answer);
    const quotedRange = explicitTransition
      ? extractQuotedRangeForTransition(quote, explicitTransition.label)
      : extractSingleQuotedRange(quote);
    if (!quotedRange) return "";

    return `отмена ${quotedRange.transition} в ${quotedRange.startTime}`;
  }

  function extractSingleQuotedRange(quotedMessage) {
    const mentions = findTransitionMentionsInText(quotedMessage);
    if (mentions.length !== 1) return null;
    return extractQuotedRangeForTransition(quotedMessage, mentions[0].label);
  }

  function extractQuotedRangeForTransition(quotedMessage, transitionLabel) {
    const matches = findTransitionMentionsInText(quotedMessage)
      .filter((item) => item.label === transitionLabel);
    if (matches.length !== 1) return null;

    const current = matches[0];
    const allMatches = findTransitionMentionsInText(quotedMessage)
      .filter((item) => item.start > current.start)
      .sort((first, second) => first.start - second.start);
    const segmentEnd = allMatches.length ? allMatches[0].start : quotedMessage.length;
    const segment = quotedMessage.slice(current.end, segmentEnd);
    const times = extractBookingTimes(segment);
    if (!times.length) return null;

    const startMinutes = timeToMinutes(times[0].time);
    const hasExplicitEnd = Boolean(times[1] && isExplicitRange(segment, times[0], times[1]) && timeToMinutes(times[1].time) > startMinutes);
    const endMinutes = hasExplicitEnd ? timeToMinutes(times[1].time) : startMinutes + 120;

    return {
      transition: transitionLabel,
      startTime: times[0].time,
      endTime: minutesToTime(Math.min(24 * 60, endMinutes))
    };
  }

  function findTransitionMentionsInText(text) {
    const source = String(text || "").toLowerCase().replace(/ё/g, "е");
    const aliases = TRANSITION_ALIASES
      .flatMap((transition) => transition.aliases.map((alias) => ({ label: transition.label, alias })))
      .sort((first, second) => second.alias.length - first.alias.length);
    const matches = [];

    aliases.forEach((item) => {
      const regexp = new RegExp(`(^|\\s)(?:в|на)?\\s*(${escapeRegexp(item.alias).replace(/\s+/g, "\\s+")})(?=\\s|$)`, "g");
      let match;
      while ((match = regexp.exec(source))) {
        const start = match.index + match[1].length;
        const end = regexp.lastIndex;
        if (!matches.some((existing) => start < existing.end && end > existing.start)) {
          matches.push({ label: item.label, alias: item.alias, start, end });
        }
      }
    });

    return matches.sort((first, second) => first.start - second.start);
  }

  function extractBookingTimes(text) {
    const result = [];
    const regexp = /(^|[^\d])(\d{1,2})(?:\s*[:.]\s*(\d{2}))?(?=\s*(?:час|ч\b|до|-|—|$|[^\d]))/giu;
    let match;

    while ((match = regexp.exec(String(text || "")))) {
      const hour = Number(match[2]);
      const minute = match[3] === undefined ? 0 : Number(match[3]);
      if (hour > 24 || minute > 59) continue;
      result.push({
        index: match.index,
        endIndex: match.index + match[0].length,
        time: normalizeBookingTime(hour, minute)
      });
    }

    return result;
  }

  function normalizeBookingTime(hour, minute) {
    const normalizedHour = hour > 0 && hour < 6 ? hour + 12 : hour;
    const totalMinutes = normalizedHour * 60 + minute;
    const rounded = Math.round(totalMinutes / 30) * 30;
    return minutesToTime(Math.min(24 * 60, Math.max(0, rounded)));
  }

  function minutesToTime(totalMinutes) {
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    return `${pad2(hour)}:${pad2(minute)}`;
  }

  function timeToMinutes(time) {
    const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return 0;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function pad2(value) {
    return value < 10 ? `0${value}` : String(value);
  }

  function isExplicitRange(text, current, next) {
    const gap = String(text || "")
      .slice(current.endIndex, next.index)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/\s+/g, " ")
      .trim();
    const atNext = String(text || "").charAt(next.index);
    return /[-—]/.test(gap) || gap === "до" || /^до(\s|$)/.test(gap) || atNext === "-" || atNext === "—";
  }

  /**
   * WhatsApp Web часто «приклеивает» к тексту пузыря служебное время списка (00:01),
   * метку «Изменено» и т.п.: «16:0000:01», «20.0000:01», «часов.00:00», «…15:30Изменено01:07».
   * Без этого сервер видит лишнее «время» и ломает диапазоны (14–16 → ещё 16–18).
   */
  function stripWhatsAppWebTimeGlue(text) {
    let s = String(text || "").trim();
    for (let guard = 0; guard < 12; guard += 1) {
      const before = s;
      s = s.replace(/изменено\s*\d{1,2}:\d{2}$/giu, "");
      s = s.replace(/(\d{1,2})[:.](\d{2})(\d{2}:\d{2})$/u, "$1:$2");
      s = s.replace(/([^\d\s])\d{1,2}:\d{2}$/u, "$1");
      s = s.replace(/\.{2,}\s*\d{1,2}:\d{2}$/u, "");
      s = s.replace(/\.(?:[01]\d|2[0-3]):[0-5]\d$/u, "");
      if (s === before) break;
    }
    return s.trim();
  }

  function sanitizeMessageForApi(message) {
    let s = stripWhatsAppWebTimeGlue(String(message || ""));
    s = s
      .replace(/\+?\d[\d\s().-]{6,}\d/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return s;
  }

  function debugPreviewMessage(text, maxLen) {
    const limit = typeof maxLen === "number" ? maxLen : 240;
    const cleaned = sanitizeMessageForApi(text);
    if (cleaned.length <= limit) return cleaned;
    return `${cleaned.slice(0, limit)}…`;
  }

  function postBooking(payload) {
    const body = JSON.stringify({ action: "whatsappBooking", ...payload });

    if (CONFIG.debug && CONFIG.debugLogApiMessage) {
      console.log("[StreetMusic WA] POST message (sanitized):", payload.message);
      console.log("[StreetMusic WA] POST meta:", {
        chatDate: payload.chatDate,
        chatTime: payload.chatTime,
        phoneLast4: payload.phoneLast4,
        messageId: payload.messageId,
        messageLen: String(payload.message || "").length
      });
    }

    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: "POST",
        url: CONFIG.apiUrl,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        data: body,
        onload: (response) => {
          if (CONFIG.debug) {
            console.log("[StreetMusic WA] response:", response.status, response.responseText);
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

    const messageParts = getMessageParts(root.cloneNode(true));
    const message = messageParts.message;
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

    if (CONFIG.debug && messageParts.answerMessage && messageParts.answerMessage !== message) {
      console.log("[StreetMusic WA] reply normalized:", debugPreviewMessage(messageParts.answerMessage), "=>", debugPreviewMessage(message));
    }

    /** Как для API: без «приклеенного» времени WA — иначе жалоба «…не появилась...01:02» уходит как бронь */
    const messageForHeuristic = stripWhatsAppWebTimeGlue(message);
    if (!isLikelyBookingText(messageForHeuristic)) {
      if (CONFIG.debug) {
        console.log(
          "[StreetMusic WA] ignored (not booking-like):",
          messageId,
          CONFIG.debugLogApiMessage ? debugPreviewMessage(message) : ""
        );
      }
      return;
    }

    if (CONFIG.debug) {
      console.log("[StreetMusic WA] sending:", messageId, CONFIG.debugLogApiMessage ? debugPreviewMessage(message) : "");
    }

    const messageForApi = sanitizeMessageForApi(message);
    if (!messageForApi) {
      if (CONFIG.debug) {
        console.warn("[StreetMusic WA] skip send: message empty after sanitize", messageId, debugPreviewMessage(message));
      }
      return;
    }

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
    console.log("[StreetMusic WA] watcher started; version:", SCRIPT_VERSION, "сегодня (Уфа):", ufaTodayIso());
    console.log("[StreetMusic WA] вручную догон: streetMusicWaBackfillToday()");
  }

  if (typeof unsafeWindow !== "undefined") {
    unsafeWindow.streetMusicWaBackfillToday = function streetMusicWaBackfillToday() {
      clearSeenForDebug();
      scanBackfillToday();
    };
    unsafeWindow.streetMusicWaUfaToday = ufaTodayIso;
    unsafeWindow.streetMusicWaWatcherVersion = SCRIPT_VERSION;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
