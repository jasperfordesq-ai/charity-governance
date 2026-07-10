import type { BrowserContext } from '@playwright/test';

import {
  createBrowserOriginPolicy,
  isGoogleFontsStylesheetRequest,
  type BrowserOriginPolicy,
} from './browser-origin-policy.cjs';

export interface BrowserOriginFence {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  install(context: BrowserContext): Promise<void>;
  checkpoint(): number;
  assertNoViolationsSince(checkpoint: number): void;
  assertNoViolations(): void;
}

function requiredTarget(name: 'E2E_WEB_URL' | 'E2E_API_URL', env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required before any E2E browser context is created.`);
  return value;
}

function violationMessage(
  policy: BrowserOriginPolicy,
  kind: 'HTTP' | 'WebSocket',
  method: string,
  value: string,
): string {
  return `${kind} ${method} ${policy.redactedUrlLabel(value)}`;
}

export function createBrowserOriginFence(env: NodeJS.ProcessEnv = process.env): BrowserOriginFence {
  const policy = createBrowserOriginPolicy({
    webUrl: requiredTarget('E2E_WEB_URL', env),
    apiUrl: requiredTarget('E2E_API_URL', env),
  });
  const guardedContexts = new WeakSet<BrowserContext>();
  const violations: string[] = [];

  const assertRange = (checkpoint: number) => {
    const blocked = [...new Set(violations.slice(checkpoint))].sort();
    if (blocked.length === 0) return;
    throw new Error(
      `Isolated E2E browser origin policy blocked ${blocked.length} request origin(s): ${blocked.join(', ')}`,
    );
  };

  return {
    apiOrigin: policy.apiOrigin,
    webOrigin: policy.webOrigin,
    async install(context) {
      if (guardedContexts.has(context)) return;
      guardedContexts.add(context);

      await context.route('**/*', async (route) => {
        const request = route.request();
        const requestUrl = request.url();
        if (policy.isAllowedHttpUrl(requestUrl)) {
          await route.continue();
          return;
        }

        // Preserve production typography without allowing live third-party
        // requests in the isolated suite. The exact stylesheet is replaced by
        // an empty local response, so no fonts.gstatic.com request can follow.
        if (isGoogleFontsStylesheetRequest(requestUrl, request.method())) {
          await route.fulfill({
            status: 200,
            contentType: 'text/css; charset=utf-8',
            body: '/* External font loading is disabled in isolated E2E. */',
          });
          return;
        }

        violations.push(violationMessage(policy, 'HTTP', request.method(), requestUrl));
        await route.abort('blockedbyclient');
      });

      await context.routeWebSocket(/.*/, async (webSocket) => {
        const socketUrl = webSocket.url();
        if (policy.isAllowedWebSocketUrl(socketUrl)) {
          webSocket.connectToServer();
          return;
        }

        violations.push(violationMessage(policy, 'WebSocket', 'CONNECT', socketUrl));
        await webSocket.close({ code: 1008, reason: 'Blocked by isolated E2E origin policy' });
      });
    },
    checkpoint() {
      return violations.length;
    },
    assertNoViolationsSince(checkpoint) {
      if (!Number.isSafeInteger(checkpoint) || checkpoint < 0 || checkpoint > violations.length) {
        throw new Error('Invalid isolated browser-origin checkpoint.');
      }
      assertRange(checkpoint);
    },
    assertNoViolations() {
      assertRange(0);
    },
  };
}
