import {
  getApiBaseUrl,
  getServerApiBaseUrl as legacyServerApiBaseUrl,
  type ApiEnv,
} from "./api-config";
import { createManagedServiceMeshBinding } from "../../../../packages/shared/runtime/managed-service-mesh.mjs";
import {
  hasManagedWebTlsSettings,
  resolveManagedWebContext,
} from "../../managed-tls.mjs";
export const createManagedWebApiBinding = createManagedServiceMeshBinding;
const refusal =
  "Managed web API binding is unavailable or does not match this deployment";
export type ManagedPublicBuild = {
  apiOrigin?: string;
  canonicalApiOrigin?: string;
  deploymentMode?: string;
  bindingSha256?: string;
};
export type ManagedServerEnv = ApiEnv & {
  PORT?: string;
  CHARITYPILOT_BUILD_COMMIT?: string;
  CHARITYPILOT_DEPLOYMENT_MODE?: string;
  CHARITYPILOT_E2E_MODE?: string;
  RENDER_SERVICE_ID?: string;
  RENDER_SERVICE_TYPE?: string;
};
export function hasManagedWebApiSettings(
  env: ManagedServerEnv,
  built?: ManagedPublicBuild,
) {
  return hasManagedWebTlsSettings(env) || Boolean(built?.bindingSha256);
}
export function getManagedWebApiContext(
  env: ManagedServerEnv = process.env,
  built?: ManagedPublicBuild,
) {
  if (!hasManagedWebApiSettings(env, built)) return null;
  try {
    if (!built?.bindingSha256 || built.deploymentMode !== "public-production")
      throw new Error();
    const r = resolveManagedWebContext(env, {
      format: 1,
      sourceSha: env.CHARITYPILOT_BUILD_COMMIT ?? "",
      bindingSha256: built.bindingSha256,
    });
    if (
      built.apiOrigin !== r.publicOrigin ||
      built.canonicalApiOrigin !== r.publicOrigin ||
      getApiBaseUrl(env) !== r.publicOrigin
    )
      throw new Error();
    return r;
  } catch {
    throw new Error(refusal);
  }
}
export function getServerApiBaseUrl(
  env: ManagedServerEnv = process.env,
  built?: ManagedPublicBuild,
) {
  return (
    getManagedWebApiContext(env, built)?.apiOrigin ??
    legacyServerApiBaseUrl(env)
  );
}
