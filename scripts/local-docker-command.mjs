import { spawnSync } from 'node:child_process';
import { validateLocalDockerEndpoint, validateLocalDockerRuntime, pinnedLocalDockerEnvironment,
  composeSafeEnvironment } from './personal-server-docker-boundary.mjs';

const refusal = 'Docker lifecycle requires a verified local Linux engine; remote or ambiguous targets are refused.';

/** Revalidate and pin each direct lifecycle child; never trust a persisted context. */
export function spawnLocalDockerCommand(command, environment, options = {}, { spawn = spawnSync, platform = process.platform } = {}) {
  try {
    if (!Array.isArray(command) || command[0] !== 'docker' || command.length < 2
      || command.some(value => typeof value !== 'string') || command[1].startsWith('-')
      || Object.entries(environment).some(([key,value]) =>
        /^(?:DOCKER_|BUILDX_|BUILDKIT_)/i.test(key) && String(value ?? '').trim())) throw new Error();
    const safe = composeSafeEnvironment(environment);
    const probe = (args, env) => {
      const result = spawn('docker', args, { encoding:'utf8',stdio:'pipe',timeout:30000,maxBuffer:131072,env });
      if (result.status !== 0 || result.error || typeof result.stdout !== 'string') throw new Error();
      return result.stdout.trim();
    };
    const context = JSON.parse(probe(['context','inspect','--format','{{json .Endpoints.docker}}'],safe));
    const endpoint = context.Host;
    validateLocalDockerEndpoint({endpoint,skipTlsVerify:context.SkipTLSVerify,platform},safe);
    const pinned = pinnedLocalDockerEnvironment(safe,endpoint);
    const info = JSON.parse(probe(['--host',endpoint,'info','--format','{{json .}}'],pinned));
    const apiVersion = probe(['--host',endpoint,'version','--format','{{.Server.APIVersion}}'],pinned);
    validateLocalDockerRuntime({endpoint,skipTlsVerify:context.SkipTLSVerify,platform,
      operatingSystem:info.OperatingSystem,serverOs:info.OSType,apiVersion},safe);
    return spawn('docker',['--host',endpoint,...command.slice(1)],{...options,env:pinned});
  } catch { throw new Error(refusal); }
}
