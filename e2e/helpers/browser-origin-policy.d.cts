export interface BrowserOriginPolicy {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  isAllowedHttpUrl(value: string): boolean;
  isAllowedWebSocketUrl(value: string): boolean;
  redactedUrlLabel(value: string): string;
}

export function createBrowserOriginPolicy(options: {
  webUrl: string;
  apiUrl: string;
}): BrowserOriginPolicy;

export function isGoogleFontsStylesheetRequest(value: string, method: string): boolean;
export function normalizeTargetOrigin(value: string, label: string): string;
export function redactedUrlLabel(value: string): string;
export const GOOGLE_FONTS_STYLESHEET_ORIGIN: string;
