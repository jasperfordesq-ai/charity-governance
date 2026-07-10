"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createBrowserOriginPolicy,
  isGoogleFontsStylesheetRequest,
  normalizeTargetOrigin,
  redactedUrlLabel,
} = require("./browser-origin-policy.cjs");

const policy = createBrowserOriginPolicy({
  webUrl: "http://127.0.0.1:3303",
  apiUrl: "http://127.0.0.1:3302",
});

test("accepts only exact configured HTTP origins and their non-network derivatives", () => {
  for (const value of [
    "http://127.0.0.1:3303/",
    "http://127.0.0.1:3303/_next/static/chunk.js?hash=one",
    "http://127.0.0.1:3302/api/v1/auth/me",
    "about:blank",
    "about:srcdoc",
    "data:text/plain,embedded",
    "blob:http://127.0.0.1:3303/8ff1f460-6500-4fb3-a0a0-e7fe5d85dace",
  ]) {
    assert.equal(policy.isAllowedHttpUrl(value), true, value);
  }

  for (const value of [
    "http://localhost:3002/api/v1/auth/me",
    "http://localhost:3003/",
    "http://127.0.0.1:3002/",
    "http://127.0.0.1:3003/",
    "http://127.0.0.1:3304/",
    "http://127.0.0.1.attacker.example:3302/",
    "https://127.0.0.1:3302/",
    "blob:http://localhost:3002/id",
    "blob:null/id",
    "file:///etc/passwd",
    "ftp://127.0.0.1:3302/file",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(policy.isAllowedHttpUrl(value), false, value);
  }
});

test("accepts WebSockets only through the protocol-equivalent exact origins", () => {
  assert.equal(policy.isAllowedWebSocketUrl("ws://127.0.0.1:3303/_next/webpack-hmr"), true);
  assert.equal(policy.isAllowedWebSocketUrl("ws://127.0.0.1:3302/socket"), true);
  assert.equal(policy.isAllowedWebSocketUrl("ws://localhost:3003/_next/webpack-hmr"), false);
  assert.equal(policy.isAllowedWebSocketUrl("wss://127.0.0.1:3303/socket"), false);
  assert.equal(policy.isAllowedWebSocketUrl("http://127.0.0.1:3303/not-a-websocket"), false);
});

test("target configuration is origin-only, credential-free, HTTP(S), and distinct", () => {
  assert.equal(normalizeTargetOrigin("http://127.0.0.1:3303/", "target"), "http://127.0.0.1:3303");
  for (const value of [
    "",
    "http://127.0.0.1:3303/path",
    "http://127.0.0.1:3303?query=one",
    "http://user@127.0.0.1:3303",
    "ws://127.0.0.1:3303",
    "file:///tmp/app",
    "not a url",
  ]) {
    assert.throws(() => normalizeTargetOrigin(value, "target"), /origin-only HTTP\(S\) URL/);
  }
  assert.throws(
    () => createBrowserOriginPolicy({ webUrl: "http://127.0.0.1:3303", apiUrl: "http://127.0.0.1:3303" }),
    /must be distinct/,
  );
});

test("violation labels expose origins but redact paths, queries, fragments, and embedded values", () => {
  assert.equal(
    redactedUrlLabel("http://localhost:3002/api/v1/auth/me?token=sensitive#fragment"),
    "http://localhost:3002",
  );
  assert.equal(redactedUrlLabel("data:text/plain,sensitive"), "data:[embedded]");
  assert.equal(redactedUrlLabel("not a url"), "[malformed-url]");
});

test("only the exact Google Fonts CSS GET is eligible for a local empty stylesheet stub", () => {
  assert.equal(
    isGoogleFontsStylesheetRequest(
      "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400&display=swap",
      "GET",
    ),
    true,
  );
  for (const [value, method] of [
    ["https://fonts.googleapis.com/css", "GET"],
    ["https://fonts.gstatic.com/s/font.woff2", "GET"],
    ["https://fonts.googleapis.com/css2?family=x", "POST"],
    ["https://fonts.googleapis.com.attacker.example/css2", "GET"],
  ]) {
    assert.equal(isGoogleFontsStylesheetRequest(value, method), false);
  }
});
