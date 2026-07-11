import {
  test,
  expect,
  uniqueEmail,
  sendInviteViaUi,
  acceptInviteViaUi,
  reliableFill,
} from '../fixtures';
import { setInviteToken, getUserAndOrg } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

const FUTURE_DATE = `${new Date().getFullYear()}-12-31`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('Deadlines & Team', () => {
  test('create a deadline then mark it complete', async ({ ownerPage }) => {
    const title = `E2E Annual Report filing ${Date.now()}`;

    await gotoWithDevServerRetry(ownerPage, '/deadlines');
    await expect(ownerPage.getByRole('heading', { name: 'Deadline Tracker' })).toBeVisible();

    // Open the modal from the page header.
    await ownerPage.getByRole('button', { name: 'Add Deadline' }).first().click();
    const dialog = ownerPage.getByRole('dialog');
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Due Date').fill(FUTURE_DATE);
    await dialog.getByRole('button', { name: 'Add Deadline' }).click();

    // The new deadline appears in the list.
    await expect(ownerPage.getByText(title)).toBeVisible();

    // Mark it complete and confirm the state flips.
    const completePatch = ownerPage.waitForResponse(
      (r) => /\/api\/v1\/deadlines\//.test(r.url()) && r.request().method() === 'PATCH',
    );
    await ownerPage.getByRole('checkbox', { name: new RegExp(`^Mark ${escapeRegExp(title)}, due .+, as complete$`) }).click();
    expect((await completePatch).ok()).toBeTruthy();

    await expect(
      ownerPage.getByRole('checkbox', { name: new RegExp(`^Mark ${escapeRegExp(title)}, due .+, as incomplete$`) }),
    ).toBeVisible();
  });

  test('generated deadline completion requires an explicit irreversible confirmation', async ({ ownerPage }) => {
    await gotoWithDevServerRetry(ownerPage, '/organisation');
    await expect(ownerPage.getByRole('heading', { name: 'Organisation' })).toBeVisible();

    const financialYearEnd = ownerPage.getByLabel('Financial year end');
    const priorYear = new Date().getFullYear() - 1;
    const primaryYearEnd = `${priorYear}-12-31`;
    const alternateYearEnd = `${priorYear}-12-30`;
    const nextYearEnd = (await financialYearEnd.inputValue()) === primaryYearEnd
      ? alternateYearEnd
      : primaryYearEnd;
    await reliableFill(financialYearEnd, nextYearEnd);

    const saved = ownerPage.waitForResponse(
      (response) => /\/api\/v1\/organisation$/.test(response.url()) && response.request().method() === 'PATCH',
    );
    const saveProfile = ownerPage.getByRole('button', { name: 'Save profile' });
    await expect(saveProfile).toBeEnabled();
    await saveProfile.click();
    expect((await saved).ok()).toBeTruthy();

    await gotoWithDevServerRetry(ownerPage, '/deadlines');
    await expect(ownerPage.getByRole('heading', { name: 'Deadline Tracker' })).toBeVisible();

    const generatedTitle = 'Charities Regulator annual report';
    const generatedRow = ownerPage.locator('article').filter({
      has: ownerPage.getByRole('heading', { name: generatedTitle, exact: true }),
    });
    await expect(generatedRow).toBeVisible();

    let completionPatchCount = 0;
    ownerPage.on('request', (request) => {
      if (/\/api\/v1\/deadlines\//.test(request.url()) && request.method() === 'PATCH') {
        completionPatchCount += 1;
      }
    });

    const incompleteCheckbox = generatedRow.getByRole('checkbox', {
      name: new RegExp(`^Mark ${escapeRegExp(generatedTitle)}, due .+, as complete$`),
    });
    await incompleteCheckbox.click();

    const completionDialog = ownerPage.getByRole('dialog', {
      name: 'Mark generated deadline complete?',
    });
    await expect(completionDialog.getByRole('heading', { name: 'Mark generated deadline complete?' })).toBeVisible();
    await expect(completionDialog.getByText(/Generated occurrences cannot be reopened, edited, or deleted\./)).toBeVisible();
    await completionDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(completionDialog).toBeHidden();
    await expect(incompleteCheckbox).not.toBeChecked();
    expect(completionPatchCount).toBe(0);

    await incompleteCheckbox.click();
    await expect(completionDialog).toBeVisible();
    const completed = ownerPage.waitForResponse(
      (response) => /\/api\/v1\/deadlines\//.test(response.url()) && response.request().method() === 'PATCH',
    );
    await completionDialog.getByRole('button', { name: 'Mark complete permanently' }).click();
    const completedResponse = await completed;
    expect(completedResponse.ok()).toBeTruthy();
    expect(completedResponse.request().postDataJSON()).toMatchObject({ isComplete: true });
    await expect(completionDialog).toBeHidden();
    expect(completionPatchCount).toBe(1);

    const completedCheckbox = generatedRow.getByRole('checkbox', {
      name: new RegExp(`^Mark ${escapeRegExp(generatedTitle)}, due .+, as incomplete$`),
    });
    await expect(completedCheckbox).toBeChecked();
    await expect(completedCheckbox).toBeDisabled();
  });

  test('invite a team member who then accepts and joins the workspace', async ({ ownerPage, owner, newFencedContext }) => {
    const inviteeEmail = uniqueEmail('invitee');

    // 1. OWNER sends an invite (HTTP 202, generic message; a pending row appears).
    await gotoWithDevServerRetry(ownerPage, '/team');
    await sendInviteViaUi(ownerPage, inviteeEmail, 'Member');
    await expect(ownerPage.getByText(/Invite sent\./).last()).toBeVisible();
    await expect(ownerPage.getByText(inviteeEmail)).toBeVisible();

    // 2. The plaintext invite token is unrecoverable (stored hashed), so set a
    //    known token on the invite row, then accept via the public page.
    const token = await setInviteToken(inviteeEmail);

    const acceptContext = await newFencedContext();
    const acceptPage = await acceptContext.newPage();
    try {
      await acceptInviteViaUi(acceptPage, token, 'Invited Teammate', 'Password123');

      // The new user belongs to the inviting owner's organisation.
      const invitee = await getUserAndOrg(inviteeEmail);
      expect(invitee.organisationId).toBe(owner.organisationId);
    } finally {
      await acceptContext.close();
    }
  });
});
