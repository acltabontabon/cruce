import { type FormEvent, type InputHTMLAttributes, type ReactNode, useId, useState } from "react";
export function Empty({ children }: { children: ReactNode }) {
	return <p className="empty">{children}</p>;
}
export function Form({
	submit,
	label,
	children,
	primary = false,
	cancel,
	className,
}: {
	submit: (data: FormData) => Promise<unknown>;
	label: string;
	children: ReactNode;
	/** Footer layout: the submit button is primary and right-aligned, with an optional Cancel beside it. */
	primary?: boolean;
	cancel?: () => void;
	className?: string;
}) {
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const button = (
		<button disabled={busy} type="submit" className={primary ? "primary" : undefined}>
			{busy ? "Saving…" : label}
		</button>
	);
	return (
		<form
			className={className}
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
			{primary || cancel ? (
				<div className="form-actions">
					{cancel && (
						<button type="button" className="quiet" onClick={cancel}>
							Cancel
						</button>
					)}
					{button}
				</div>
			) : (
				button
			)}
		</form>
	);
}
/** A labelled input with a fixed visual prefix (a handle or scope) that stays out of the accessible name. */
export function PrefixedInput({
	label,
	prefix,
	hint,
	...input
}: { label: string; prefix: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
	const id = useId();
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<span className="prefixed">
				<span aria-hidden="true">{prefix}</span>
				<input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
			</span>
			{hint && <small id={`${id}-hint`}>{hint}</small>}
		</div>
	);
}
export const value = (d: FormData, key: string) => String(d.get(key) ?? "");

export const count = (n: number, label: string, plural = `${label}s`) => `${n} ${n === 1 ? label : plural}`;
export const short = (s?: string) => s?.slice(0, 8) ?? "—";
export const time = (n: number) => new Date(n).toLocaleString();
