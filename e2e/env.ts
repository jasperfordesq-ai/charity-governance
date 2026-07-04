export const IS_DEPLOYED_QA = process.env.E2E_DEPLOYED_QA === 'true';

export function deployedQaOwnerCredentials(): { email: string; password: string } {
  const email = process.env.E2E_OWNER_EMAIL?.trim();
  const password = process.env.E2E_OWNER_PASSWORD?.trim();

  if (!email || !password) {
    throw new Error(
      'E2E_DEPLOYED_QA=true requires E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD for an approved non-sensitive test workspace.',
    );
  }

  return { email, password };
}
