/** One request at a time per resource. Disposed/forced refreshes cannot deliver late results. */
export function poll<T>(load: (signal: AbortSignal) => Promise<T>, accept: (data: T) => void, reject: (error: Error) => void) {
	const controller = new AbortController();
	let pending = false;
	const run = async () => {
		if (pending || controller.signal.aborted) return;
		pending = true;
		try {
			const data = await load(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
			if (!controller.signal.aborted) accept(data);
		} catch (error) {
			if (!controller.signal.aborted) reject(error as Error);
		} finally {
			pending = false;
		}
	};
	void run();
	const timer = setInterval(() => void run(), 15000);
	return () => {
		controller.abort();
		clearInterval(timer);
	};
}
