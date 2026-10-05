import { type FormEvent, type ReactNode, useState } from "react";
export function Empty({ children }: { children: ReactNode }) {
	return <p className="empty">{children}</p>;
}
export function Form({ submit, label, children }: { submit: (data: FormData) => Promise<unknown>; label: string; children: ReactNode }) {
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	return (
		<form
			onSubmit={async (e: FormEvent<HTMLFormElement>) => {
				e.preventDefault();
				const form = e.currentTarget;
				setBusy(true);
				setError("");
				try {
					await submit(new FormData(form));
				} catch (e) {
					setError((e as Error).message);
				} finally {
					setBusy(false);
				}
			}}
		>
			{children}
			{error && <p role="alert">{error}</p>}
			<button disabled={busy} type="submit">
				{busy ? "Saving…" : label}
			</button>
		</form>
	);
}
export const value = (d: FormData, key: string) => String(d.get(key) ?? "");

export const count = (n: number, label: string, plural = `${label}s`) => `${n} ${n === 1 ? label : plural}`;
export const short = (s?: string) => s?.slice(0, 8) ?? "—";
export const time = (n: number) => new Date(n).toLocaleString();
