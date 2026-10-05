import { type ReactNode, useEffect, useState } from "react";
import { BRAND } from "./brand.tsx";
import { Dialog, Icon } from "./design.tsx";

export function Shell({ navigation, children, routeKey }: { navigation: ReactNode; children: ReactNode; routeKey: string }) {
	const [menu, setMenu] = useState(false);
	useEffect(() => {
		void routeKey;
		setMenu(false);
	}, [routeKey]);
	return (
		<div className="shell">
			<button type="button" className="skip" onClick={() => document.getElementById("content")?.focus()}>
				Skip to content
			</button>
			<div className="mobile-header">
				<img src={BRAND.symbol} alt="" width="28" height="28" />
				<strong>{BRAND.name}</strong>
				<button type="button" aria-label="Open navigation" aria-expanded={menu} onClick={() => setMenu(true)}>
					<Icon name="menu" />
				</button>
			</div>
			<aside className="desktop-sidebar">{navigation}</aside>
			{menu && (
				<Dialog title="Navigation" close={() => setMenu(false)} className="navigation-drawer">
					{/* Navigation controls retain their own semantics; delegation closes the drawer before a picker opens. */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: Delegated dismissal; child buttons and links handle keyboard activation. */}
					<div
						className="drawer-content"
						onClick={(event) => {
							if ((event.target as HTMLElement).closest("button,a")) setMenu(false);
						}}
						onKeyDown={() => {}}
					>
						{navigation}
					</div>
				</Dialog>
			)}
			{children}
		</div>
	);
}
