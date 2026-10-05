import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SessionBoundary } from "./session.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<StrictMode>
			<SessionBoundary />
		</StrictMode>,
	);
