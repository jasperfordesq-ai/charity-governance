"use strict";

const GOOGLE_FONTS_STYLESHEET_ORIGIN = "https://fonts.googleapis.com";

function fail(message) {
  throw new Error(message);
}

function normalizeTargetOrigin(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be an explicit origin-only HTTP(S) URL.`);
  }

  const trimmed = value.trim();
  const normalized = trimmed.replace(/\/+$/, "");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    fail(`${label} must be an explicit origin-only HTTP(S) URL.`);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== normalized ||
    url.username ||
    url.password
  ) {
    fail(`${label} must be an explicit origin-only HTTP(S) URL.`);
  }

  return url.origin;
}

function protocolEquivalentHttpOrigin(url) {
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  const equivalent = new URL(url.href);
  equivalent.protocol = url.protocol === "ws:" ? "http:" : "https:";
  return equivalent.origin;
}

function redactedUrlLabel(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "blob:") {
      return url.origin === "null" ? "blob:[opaque]" : `blob:${url.origin}`;
    }
    if (url.protocol === "data:") return "data:[embedded]";
    if (url.protocol === "about:") return `about:${url.pathname}`;
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return url.origin;
    return `${url.protocol}[redacted]`;
  } catch {
    return "[malformed-url]";
  }
}

function createBrowserOriginPolicy({ webUrl, apiUrl }) {
  const webOrigin = normalizeTargetOrigin(webUrl, "E2E_WEB_URL");
  const apiOrigin = normalizeTargetOrigin(apiUrl, "E2E_API_URL");
  if (webOrigin === apiOrigin) {
    fail("E2E_WEB_URL and E2E_API_URL must be distinct exact origins.");
  }
  const allowedOrigins = new Set([webOrigin, apiOrigin]);

  function isAllowedHttpUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }

    if (url.protocol === "about:") {
      return value === "about:blank" || value === "about:srcdoc";
    }
    if (url.protocol === "data:") return true;
    if (url.protocol === "blob:") {
      return url.origin !== "null" && allowedOrigins.has(url.origin);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return allowedOrigins.has(url.origin);
  }

  function isAllowedWebSocketUrl(value) {
    try {
      const url = new URL(value);
      const equivalentOrigin = protocolEquivalentHttpOrigin(url);
      return equivalentOrigin !== null && allowedOrigins.has(equivalentOrigin);
    } catch {
      return false;
    }
  }

  return Object.freeze({
    apiOrigin,
    webOrigin,
    isAllowedHttpUrl,
    isAllowedWebSocketUrl,
    redactedUrlLabel,
  });
}

function isGoogleFontsStylesheetRequest(value, method) {
  if (method !== "GET") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === GOOGLE_FONTS_STYLESHEET_ORIGIN &&
      url.pathname === "/css2" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

module.exports = {
  GOOGLE_FONTS_STYLESHEET_ORIGIN,
  createBrowserOriginPolicy,
  isGoogleFontsStylesheetRequest,
  normalizeTargetOrigin,
  redactedUrlLabel,
};
