import { useEffect, useState } from "react";

export function App() {
	const [snap, setSnap] = useState<unknown>(null);
	useEffect(() => {
		fetch("/api/projects/demo").then((r) => r.json()).then(setSnap);
	}, []);
	return <pre style={{ color: "#ddd", background: "#111", padding: 16 }}>{JSON.stringify(snap, null, 2)?.slice(0, 4000)}</pre>;
}
