export type ManagedServiceImagePin = Readonly<{
  format: 1;
  sourceSha: string;
  bindingSha256: string;
}>;
export function parseManagedServiceImagePin(
  raw: string,
  requireEnabled?: boolean,
): ManagedServiceImagePin | null;
export function readManagedServiceImagePin(
  service: "api" | "web",
  requireEnabled?: boolean,
): ManagedServiceImagePin | null;
