import { api } from './api';
import type {
  DeadlinePage,
  DeadlineReminderHistoryEntry,
  DeadlineView,
} from './deadline-contract';

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function decodeDeadlinePage<T>(payload: unknown): DeadlinePage<T> {
  if (Array.isArray(payload)) {
    return {
      data: payload as T[],
      total: payload.length,
      page: 1,
      pageSize: payload.length,
      hasMore: false,
    };
  }
  const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const nested = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : null;
  const source = nested && Array.isArray(nested.data) ? nested : envelope;
  const data = asArray<T>(source.data);
  return {
    data,
    total: typeof source.total === 'number' ? source.total : data.length,
    page: typeof source.page === 'number' ? source.page : 1,
    pageSize: typeof source.pageSize === 'number' ? source.pageSize : data.length,
    hasMore: source.hasMore === true,
  };
}

const MAX_PAGE_REQUESTS = 1_000;

export async function collectAllDeadlinePages<T>(
  loadPage: (page: number) => Promise<DeadlinePage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGE_REQUESTS; page += 1) {
    const result = await loadPage(page);
    rows.push(...result.data);
    if (!result.hasMore) return rows;
    if (result.page !== page || result.data.length === 0) {
      throw new Error('Deadline pagination did not advance safely.');
    }
  }
  throw new Error('Deadline pagination exceeded the safe request limit.');
}

export async function listCurrentDeadlines(): Promise<DeadlineView[]> {
  return collectAllDeadlinePages(async (page) => {
    const response = await api.get('/deadlines', {
      params: { status: 'current', page, pageSize: 100 },
    });
    return decodeDeadlinePage<DeadlineView>(response.data);
  });
}

export async function listDeadlineHistory(page = 1): Promise<DeadlinePage<DeadlineView>> {
  const response = await api.get('/deadlines/history', { params: { page, pageSize: 20 } });
  return decodeDeadlinePage<DeadlineView>(response.data);
}

export async function listDeadlineReminderHistory(
  page = 1,
): Promise<DeadlinePage<DeadlineReminderHistoryEntry>> {
  const response = await api.get('/deadlines/reminder-history', {
    params: { page, pageSize: 20 },
  });
  return decodeDeadlinePage<DeadlineReminderHistoryEntry>(response.data);
}
