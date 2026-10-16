import type { RequestListener } from "node:http";
import type { Server } from "node:https";
import type { ManagedServiceMeshRecord } from "../../packages/shared/runtime/managed-service-mesh.mjs";
type Environment = Record<string, string | undefined>;
export type ManagedWebImagePin = {
  format: 1;
  sourceSha: string;
  bindingSha256: string;
};
export function hasManagedWebTlsSettings(env: Environment): boolean;
export function resolveManagedWebContext(
  env: Environment,
  pin: ManagedWebImagePin,
): ManagedServiceMeshRecord;
export function createManagedWebHttpsServer(
  env: Environment,
  pin: ManagedWebImagePin,
  material: { issuerCertPem: string; certPem: string; keyPem: string },
  handler: RequestListener,
): Server;
export function loadManagedWebTls(
  env?: Environment,
): ((handler: RequestListener) => Server) | null;
export function managedWebAuthMe(
  env: Environment,
  pin: ManagedWebImagePin,
  cookie: string,
  signal?: AbortSignal,
): Promise<Response | null>;
export function closeManagedWebClients(): void;
