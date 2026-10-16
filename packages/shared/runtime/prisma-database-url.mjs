const allowed = new Set(['sslmode','sslrootcert','target_session_attrs','connect_timeout','application_name']);
const controls=/[\x00-\x1f\x7f]/u;

/** Confidential driver transport only. The returned URL contains credentials:
 * never log it. Preserve the original canonical URL for libpq/backup tooling.
 * This normalises TLS settings; actual target/read-write/role checks are separate.
 */
export function toStrictPrismaTlsUrl(raw) {
  try {
    if(typeof raw!=='string'||!raw||raw.length>8192||raw!==raw.trim()||controls.test(raw)) throw new Error();
    const url=new URL(raw);
    if(!['postgresql:','postgres:'].includes(url.protocol)||raw.includes('#')||!url.hostname||!url.username||!url.password||url.pathname.length<2
      || [url.username,url.password,url.pathname.slice(1)].some(value=>controls.test(decodeURIComponent(value)))) throw new Error();
    const seen=new Set();
    for(const [key] of url.searchParams) {
      if(!allowed.has(key)||seen.has(key)) throw new Error();
      seen.add(key);
    }
    if(url.searchParams.get('sslmode')!=='verify-full'||url.searchParams.get('target_session_attrs')!=='read-write') throw new Error();
    const ca=url.searchParams.get('sslrootcert');
    if(ca!==null&&ca!=='system'&&(ca.length>2048||!/^(?:\/|[A-Za-z]:[\\/])/u.test(ca)||controls.test(ca)||ca.includes('%'))) throw new Error();
    const timeout=url.searchParams.get('connect_timeout');
    if(timeout!==null&&(!/^[1-9][0-9]?$/u.test(timeout)||Number(timeout)>30)) throw new Error();
    const application=url.searchParams.get('application_name');
    if(application!==null&&!/^[A-Za-z0-9_.-]{1,63}$/u.test(application)) throw new Error();
    url.searchParams.set('sslmode','require');
    url.searchParams.set('sslaccept','strict');
    url.searchParams.delete('sslrootcert');
    if(ca&&ca!=='system') url.searchParams.set('sslcert',ca);
    return url.href;
  } catch {
    throw new Error('A canonical verified-TLS database URL is required for Prisma transport.');
  }
}
