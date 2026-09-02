import { redirect } from 'next/navigation';

// The console has no landing page of its own: /owner/tenants IS the console's
// home, and every other owner route is reached from it. Without this redirect a
// bare /owner 404s, so an operator who types or bookmarks the obvious URL gets a
// dead end and has to learn the deeper path (observed on the private VM,
// 2026-09-02).
//
// Redirect to /owner/tenants rather than /owner/login: an already-authenticated
// operator must land on the console, and an unauthenticated one still ends up at
// the login page because lib/owner-api.ts's interceptor calls
// redirectToOwnerLogin() on an unrecoverable 401 (see its 401 handling). Sending
// everyone to /owner/login instead would bounce signed-in operators away from the
// thing they asked for.
export default function OwnerConsoleIndexPage() {
  redirect('/owner/tenants');
}
