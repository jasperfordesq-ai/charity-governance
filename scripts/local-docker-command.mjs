// The PostgreSQL proof binds that helper's own source hash. Keep the shared
// implementation there rather than introducing an unbound backup dependency.
export { spawnLocalDockerCommand } from './postgres-backup.mjs';
