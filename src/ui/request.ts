export class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
export async function request<T>(url: string, body?: unknown, method = body ? "POST" : "GET", signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, {
		method,
		credentials: "same-origin",
		signal,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const expired = response.status === 401 || (response.redirected && !response.headers.get("content-type")?.includes("application/json"));
	if (expired && url.startsWith("/api/") && !signal?.aborted) {
		window.dispatchEvent(new Event("cruce:session-expired"));
		throw new RequestError(401, "Sign in again");
	}
	if (!response.headers.get("content-type")?.includes("application/json")) throw new RequestError(503, "Service unavailable; retry");
	const data = await response.json();
	if (!response.ok) throw new RequestError(response.status, data.error ?? "Request failed");
	return data;
}
