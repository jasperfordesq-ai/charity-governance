export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
  return data?.error ?? data?.message ?? fallback;
}

export function isApiNotFoundError(error: unknown): boolean {
  return (error as { response?: { status?: unknown } })?.response?.status === 404;
}

export function isApiForbiddenError(error: unknown): boolean {
  const response = (error as {
    response?: { status?: unknown; data?: { code?: unknown } | null } | null;
  })?.response;
  return response?.status === 403 && response.data?.code === 'FORBIDDEN';
}
