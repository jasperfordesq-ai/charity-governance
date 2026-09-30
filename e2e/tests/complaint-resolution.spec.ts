import { test, expect, reliableFill, uniqueEmail, TEST_PASSWORD } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { createAuthenticatedStorageState, createVerifiedOwner, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test('complaint resolution reviews preserve corrections, reject competing reviews and become stale after reopening', async ({ newFencedContext }) => {
  test.skip(IS_DEPLOYED_QA, 'Synthetic complaints require the identity-bound disposable database.');
  test.setTimeout(120_000);
  const owner = await createVerifiedOwner({ email: uniqueEmail('resolution'), password: TEST_PASSWORD,
    name: 'Resolution Owner', organisationName: 'Isolated Resolution Charity' });
  const context = await newFencedContext({ storageState: await createAuthenticatedStorageState({ ...owner, role: 'OWNER' }) });
  const id = `resolution-${Date.now()}`;
  await withDb(async (client) => {
    await client.query(`UPDATE "Subscription" SET plan='COMPLETE', "updatedAt"=now() WHERE "organisationId"=$1`, [owner.organisationId]);
    await client.query(`INSERT INTO "ComplaintRecord" (id,"organisationId","receivedDate",summary,status,"updatedAt")
      VALUES ($1,$2,$3,'Synthetic resolution complaint','CLOSED',now())`, [id, owner.organisationId, `${new Date().getFullYear()}-01-01`]);
  });
  const pages = [await context.newPage(), await context.newPage()];
  const panels = pages.map(page => page.getByRole('region', { name: 'Complaint resolution evidence' }));
  for (let index = 0; index < pages.length; index++) {
    await gotoWithDevServerRetry(pages[index], '/registers');
    await panels[index].getByLabel('Complaint to review').selectOption(id);
    await expect(panels[index].getByText('No resolution evidence recorded.')).toBeVisible();
    await reliableFill(panels[index].getByLabel('Resolution time (your local time)'), `${new Date().getFullYear()}-01-02T12:00`);
    await reliableFill(panels[index].getByLabel('Controlled resolution evidence reference'), 'RESOLUTION-001');
    await reliableFill(panels[index].getByLabel('Resolution review reason'), 'Reviewed the synthetic resolution evidence.');
  }
  const responses = pages.map(page => page.waitForResponse(response => response.url().endsWith(`/complaints/${id}/resolution-evidence`) && response.request().method() === 'POST'));
  await Promise.all(panels.map(panel => panel.getByRole('button', { name: 'Record resolution evidence', exact: true }).click()));
  const statuses = await Promise.all(responses.map(async response => (await response).status()));
  expect([...statuses].sort()).toEqual([201, 409]);
  const winner = panels[statuses.indexOf(201)];
  const loser = panels[statuses.indexOf(409)];
  await expect(loser.getByRole('alert')).toContainText('changed');
  await expect(winner.getByText('Resolution evidence matches this version.', { exact: false })).toBeVisible();
  await expect(winner.getByText('A current approved complaint policy is required.')).toBeVisible();
  const winnerPage = pages[statuses.indexOf(201)];
  const policies = winnerPage.getByRole('region', { name: 'Complaint retention policies' });
  await policies.getByLabel('Retention rule').selectOption('AFTER_ANCHOR');
  await reliableFill(policies.getByLabel('Minimum retention days'), '1');
  await reliableFill(policies.getByLabel('Recovery days after removal'), '30');
  await policies.getByRole('button', { name: 'Review approval' }).click();
  await reliableFill(winnerPage.getByLabel('Policy approval evidence reference'), 'SYNTHETIC-COMPLAINT-POLICY');
  await winnerPage.getByRole('checkbox', { name: /I have authority to approve these exact terms/ }).check();
  const approved = winnerPage.waitForResponse(response => response.url().endsWith('/complaints/policy-revisions') && response.request().method() === 'POST');
  await winnerPage.getByRole('button', { name: 'Approve and replace earlier approvals' }).click();
  expect((await approved).status()).toBe(201);
  await winner.getByRole('button', { name: 'Reload complaint review' }).click();
  await expect(winner.getByText('The minimum retention period has elapsed; removal still requires review.')).toBeVisible();
  await reliableFill(winner.getByLabel('Controlled resolution evidence reference'), 'RESOLUTION-002');
  await reliableFill(winner.getByLabel('Resolution review reason'), 'The synthetic case reference needs correction.');
  await winner.getByRole('button', { name: 'Withdraw resolution evidence', exact: true }).click();
  await expect(winner.locator('ol > li')).toHaveCount(2);
  await expect(winner.getByText('No current resolution evidence applies to this version.', { exact: false })).toBeVisible();
  await expect(winner.getByText('Current resolution evidence must be reviewed first.')).toBeVisible();
  await expect(winner.getByRole('button', { name: 'Withdraw resolution evidence', exact: true })).toBeDisabled();
  await reliableFill(winner.getByLabel('Resolution time (your local time)'), `${new Date().getFullYear()}-01-03T12:00`);
  await reliableFill(winner.getByLabel('Controlled resolution evidence reference'), 'RESOLUTION-003');
  await reliableFill(winner.getByLabel('Resolution review reason'), 'Rechecked the corrected synthetic evidence.');
  await winner.getByRole('button', { name: 'Record resolution evidence', exact: true }).click();
  await expect(winner.locator('ol > li')).toHaveCount(3);
  await withDb(client => client.query(`UPDATE "ComplaintRecord" SET status='OPEN', "updatedAt"=now() WHERE id=$1 AND "organisationId"=$2`, [id, owner.organisationId]));
  await winner.getByRole('button', { name: 'Reload complaint review' }).click();
  await expect(winner.getByText('No current resolution evidence applies to this version.', { exact: false })).toBeVisible();
  await expect(winner.getByRole('button', { name: 'Record resolution evidence', exact: true })).toBeDisabled();
  await expect(winner.locator('ol > li')).toHaveCount(3);
});
