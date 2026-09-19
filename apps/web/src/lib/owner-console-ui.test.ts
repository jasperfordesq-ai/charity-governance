import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Concern: the platform operator console. The API proves the authorisation and
// the validation independently; these source checks keep the console's own
// wiring honest — that every change carries a reason, that a setting the
// deployment forbids cannot be chosen, and that the whole tenant list is
// actually reachable.

const WEB = process.cwd();
const owner = (...parts: string[]) =>
  readFileSync(join(WEB, 'src', 'app', '(owner)', 'owner', ...parts), 'utf8');

test('the tenant list can reach past its first page', () => {
  // The API has returned a cursor since the console shipped and nothing spent
  // it, so every tenant past the first page was unreachable from the interface.
  const page = owner('tenants', 'page.tsx');

  assert.match(page, /nextCursor/);
  assert.match(page, /cursor: nextCursor/);
  assert.match(page, /Load more/);
});

test('the tenant list can be filtered by lifecycle status', () => {
  const page = owner('tenants', 'page.tsx');

  assert.match(page, /status === 'ALL' \? \{\} : \{ status \}/);
  assert.match(page, /SUSPENDED/);
  assert.match(page, /CLOSED/);
});

test('changing the search resets to the first page rather than appending', () => {
  // Appending would leave earlier pages on screen showing results that no
  // longer match what was typed.
  const page = owner('tenants', 'page.tsx');

  assert.match(page, /setTenants\(result\.tenants\)/);
  assert.match(page, /setTenants\(\(current\) => \[\.\.\.current, \.\.\.result\.tenants\]\)/);
});

test('a configuration change cannot be saved without a reason', () => {
  const panel = owner('tenants', '[id]', 'tenant-configuration-panel.tsx');

  assert.match(panel, /reason: reason\.trim\(\)/);
  assert.match(panel, /isDisabled=\{nothingToSave \|\| !reason\.trim\(\) \|\| saving\}/);
});

test('only the settings that actually changed are sent', () => {
  // A save that posted every field would reset a setting the operator never
  // looked at, using whatever the form happened to render.
  const panel = owner('tenants', '[id]', 'tenant-configuration-panel.tsx');

  assert.match(panel, /const nothingToSave = Object\.keys\(change\)\.length === 0/);
  assert.match(panel, /=== configuration\.documentStorageAlphaOptIn/);
});

test('"follow the deployment default" is a real choice, distinct from omitting one', () => {
  const panel = owner('tenants', '[id]', 'tenant-configuration-panel.tsx');

  assert.match(panel, /DEFAULT_PROVIDER_KEY/);
  assert.match(panel, /documentStorageProvider: null/);
  assert.match(panel, /deploymentDefaultProvider/);
});

test('a provider the deployment forbids cannot be chosen, and says why', () => {
  const panel = owner('tenants', '[id]', 'tenant-configuration-panel.tsx');

  assert.match(panel, /isDisabled=\{!option\.selectable\}/);
  assert.match(panel, /unavailableBecause/);
});

test('an alpha provider is labelled as alpha rather than looking ordinary', () => {
  const panel = owner('tenants', '[id]', 'tenant-configuration-panel.tsx');

  assert.match(panel, /option\.stage === 'ga' \? option\.id : `\$\{option\.id\} \(\$\{option\.stage\}\)`/);
});

test('Confluence is shown as read-only, and explained', () => {
  // Connecting needs the charity to sign in to Atlassian themselves, so a
  // control here would be a button that could never work.
  const panel = owner('tenants', '[id]', 'tenant-configuration-panel.tsx');

  assert.match(panel, /Connecting Confluence needs the charity to sign in to Atlassian/);
  assert.doesNotMatch(panel, /updateConfluence|connectConfluence|disconnectConfluence/);
});

test('the configuration panel is not offered for a closed charity', () => {
  const page = owner('tenants', '[id]', 'page.tsx');

  assert.match(page, /lifecycleStatus !== 'CLOSED' \? \(\s*<TenantConfigurationPanel/);
});

test('the console never offers to delete a tenant outright', () => {
  // Closing is terminal and deliberate; there is no hard delete, and the
  // console must not imply there is one.
  for (const file of [
    owner('tenants', 'page.tsx'),
    owner('tenants', '[id]', 'page.tsx'),
    owner('tenants', '[id]', 'tenant-configuration-panel.tsx'),
  ]) {
    assert.doesNotMatch(file, /client\.delete\(/);
  }
});

test('the console says whose account is acting', () => {
  // Every action here is recorded against a name in somebody else's audit
  // trail, so the operator should be able to see which name that is. The
  // endpoint has existed since the console shipped with nothing calling it.
  const layout = readFileSync(join(WEB, 'src', 'app', '(owner)', 'layout.tsx'), 'utf8');
  const identity = readFileSync(join(WEB, 'src', 'app', '(owner)', 'owner-identity.tsx'), 'utf8');

  assert.match(layout, /<OwnerIdentity \/>/);
  assert.match(identity, /ownerApi\s*\n?\s*\.me\(\)/);
  assert.match(identity, /Signed in as/);
});

test('the identity is not requested on the pages that have no session', () => {
  // Asking there produces a 401 the client would try to refresh and then
  // redirect on, throwing somebody off the page they are signing in from.
  const identity = readFileSync(join(WEB, 'src', 'app', '(owner)', 'owner-identity.tsx'), 'utf8');

  assert.match(identity, /pathname === '\/owner\/login'/);
  assert.match(identity, /pathname === '\/owner\/set-password'/);
});

test('the console does not exist on a single-tenant deployment', () => {
  // The API has always been the authority: ownerRoutes registers nothing when
  // the deployment is single-tenant, so every /api/v1/owner path answers 404.
  // The pages did not know that and rendered a console that could only fail.
  const gate = readFileSync(
    join(WEB, 'src', 'app', '(owner)', 'owner', 'layout.tsx'),
    'utf8',
  );

  // Matched as one expression on purpose. Asserting the two names appear
  // somewhere in the file passes against `if (false) notFound()`, which is a
  // console with no gate at all.
  assert.match(gate, /if \(!webTenancyIsMulti\(\)\) notFound\(\);/);
});

test('the second factor field appears only once the server asks for it', () => {
  // Showing it to everybody asks most operators for something they do not
  // have, and an empty box beside a password makes people think they have
  // forgotten something.
  const page = owner('login', 'page.tsx');

  assert.match(page, /SECOND_FACTOR_REQUIRED/);
  assert.match(page, /needsSecondFactor \? \(/);
});

test('an operator who lost their authenticator is offered the way back in', () => {
  const page = owner('login', 'page.tsx');

  assert.match(page, /I have lost my authenticator/);
  assert.match(page, /recoveryCode/);
});

test('recovery codes are presented as shown once and never again', () => {
  const page = owner('security', 'page.tsx');

  assert.match(page, /Save these now\. They are not shown again\./);
  assert.match(page, /Keep them somewhere other than the device generating your codes/);
});

test('enrolment requires proving a code, and says why', () => {
  const page = owner('security', 'page.tsx');

  assert.match(page, /scanning alone would leave you\s*\n?\s*locked out if the setup were wrong/);
  assert.match(page, /completeSecondFactor/);
});

test('turning the second factor off requires a current code', () => {
  const page = owner('security', 'page.tsx');

  assert.match(page, /isDisabled=\{code\.trim\(\)\.length === 0\}/);
  assert.match(page, /removeSecondFactor\(\{ code: code\.trim\(\) \}\)/);
});

test('the console never offers to remove another operator’s second factor', () => {
  // That would be a way around the factor, not a way to support somebody who
  // lost their phone.
  const security = owner('security', 'page.tsx');

  assert.doesNotMatch(security, /operatorId/);
});
