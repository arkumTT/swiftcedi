const API_BASE_URL = 'http://localhost:4000' //|| import.meta.env.VITE_API_BASE_URL || '/api';
const TOKEN_STORAGE_KEY = 'swiftcedi.token';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

type QueryValue = string | number | boolean | undefined | null;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(API_BASE_URL + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function request<T>(
  method: string,
  path: string,
  { body, query }: { body?: unknown; query?: Record<string, QueryValue> } = {}
): Promise<T> {
  const token = getToken();
  const res = await fetch(buildUrl(path, query), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    setToken(null);
    // A hard redirect (not a router navigate) so every in-flight query and
    // context resets cleanly — an expired/invalid session invalidates
    // everything currently held in memory, not just the current screen.
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError('session expired', 401);
  }

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const message = (isJson && payload && (payload as { error?: string }).error) || res.statusText;
    throw new ApiError(message, res.status);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** For endpoints returning a raw body (e.g. CSV export) rather than JSON. */
  getRaw: async (path: string, query?: Record<string, QueryValue>): Promise<string> => {
    const token = getToken();
    const res = await fetch(buildUrl(path, query), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.statusText, res.status);
    return res.text();
  },
};
