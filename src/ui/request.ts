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
	const data = await response.json();
	if (!response.ok) throw new RequestError(response.status, data.error ?? "Request failed");
	return data;
}
