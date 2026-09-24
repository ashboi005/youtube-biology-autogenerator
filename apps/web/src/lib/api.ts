const BASE = (process.env.NEXT_PUBLIC_SERVER_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    credentials: "include",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && ("error" in data ? data.error : "message" in data ? data.message : null)) ||
      (res.status === 422 ? "Please check what you typed" : `Something went wrong (${res.status})`);
    if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
      location.href = "/login";
    }
    throw new ApiError(res.status, String(msg));
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** PUT a blob to a presigned URL with progress. Returns the ETag header. */
export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string | null,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.getResponseHeader("ETag") ?? "")
        : reject(new ApiError(xhr.status, `Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new ApiError(0, "Upload interrupted — check your connection"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(body);
  });
}
