export function getPrimaryFrontendOrigin(frontendUrl = process.env.FRONTEND_URL): string {
  const primaryOrigin = frontendUrl
    ?.split(',')
    .map((origin) => origin.trim())
    .find(Boolean);

  return (primaryOrigin ?? 'http://localhost:3000').replace(/\/+$/, '');
}
