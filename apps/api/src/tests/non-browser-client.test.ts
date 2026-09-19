import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_CLIENT_HEADER,
  assertNonBrowserClient,
} from '../utils/non-browser-client.js';

type Req = {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
};

function connectorRequest(overrides: Partial<Req> = {}): Req {
  return {
    headers: { [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0' },
    cookies: {},
    ...overrides,
  };
}

test('a request from the connector and nothing else is accepted', () => {
  const result = assertNonBrowserClient(connectorRequest() as never);
  assert.equal(result.ok, true);
});

test('a request without the client header is refused', () => {
  const result = assertNonBrowserClient({ headers: {}, cookies: {} } as never);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.statusCode, 403);
  assert.equal(result.payload.code, 'BROWSER_CLIENT_REJECTED');
});

test('a truthy but malformed client header is not enough', () => {
  for (const value of ['yes', 'mcp-connector', 'mcp-connector/', 'other/1.0.0', '1.0.0']) {
    const result = assertNonBrowserClient(
      { headers: { [CONNECTOR_CLIENT_HEADER]: value }, cookies: {} } as never,
    );
    assert.equal(result.ok, false, `${value} must not be accepted`);
  }
});

test('browser evidence is refused even when the client header is present', () => {
  // A browser attaches all of these itself and page script cannot remove them.
  // Node's fetch sends none of them, so their presence means a browser.
  //
  // sec-fetch-mode is absent on purpose: Node's fetch DOES send it, on every
  // request, so requiring its absence would refuse the connector itself. It is
  // covered by the case below instead.
  const evidence: Array<[string, string]> = [
    ['origin', 'https://app.charitypilot.ie'],
    ['referer', 'https://app.charitypilot.ie/login'],
    ['sec-fetch-site', 'same-origin'],
    ['sec-fetch-dest', 'empty'],
  ];

  for (const [header, value] of evidence) {
    const result = assertNonBrowserClient(
      connectorRequest({
        headers: { [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0', [header]: value },
      }) as never,
    );
    assert.equal(result.ok, false, `${header} must be refused`);
    if (result.ok) continue;
    assert.equal(result.payload.code, 'BROWSER_CLIENT_REJECTED');
  }
});

test('an allow-listed origin is refused too, not just a foreign one', () => {
  // The waiver is "no origin at all", not "an origin we happen to trust".
  const result = assertNonBrowserClient(
    connectorRequest({
      headers: {
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        origin: 'http://localhost:3003',
      },
    }) as never,
  );
  assert.equal(result.ok, false);
});

test('an auth cookie is refused, so a signed-in browser cannot reach these routes', () => {
  for (const cookie of ['charitypilot_access', 'charitypilot_refresh']) {
    const result = assertNonBrowserClient(
      connectorRequest({ cookies: { [cookie]: 'some-value' } }) as never,
    );
    assert.equal(result.ok, false, `${cookie} must be refused`);
  }
});

test('the refusal says nothing about credentials', () => {
  const result = assertNonBrowserClient({ headers: {}, cookies: {} } as never);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const message = JSON.stringify(result.payload).toLowerCase();
  for (const leak of ['password', 'token', 'email', 'secret']) {
    assert.ok(!message.includes(leak), `the refusal must not mention ${leak}`);
  }
});

test('a header arriving more than once is judged on its first value, not skipped', () => {
  const result = assertNonBrowserClient(
    connectorRequest({
      headers: {
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        origin: ['https://evil.example', 'https://also-evil.example'],
      },
    }) as never,
  );
  assert.equal(result.ok, false, 'a repeated origin header must still count as browser evidence');
});

test("sec-fetch-mode alone is not browser evidence, because Node's fetch sends it", () => {
  // Found the hard way: the connector could not sign in against a real API
  // because undici sets sec-fetch-mode: cors on every request it makes. A
  // browser sends sec-fetch-site and sec-fetch-dest beside it, and those two
  // still refuse, so nothing is lost by admitting this one.
  const result = assertNonBrowserClient(
    connectorRequest({
      headers: {
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        'sec-fetch-mode': 'cors',
        'user-agent': 'node',
        accept: '*/*',
        'accept-language': '*',
      },
    }) as never,
  );

  assert.equal(result.ok, true, "the connector's own request shape must be allowed");
});
