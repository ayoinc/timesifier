import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import { report, startReporting } from "./browser-errors/reporter";

// React Router's default browser entry, plus the error reports (TS-107d): they
// start before the page hydrates, so an error while it does is reported too.

startReporting();

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<HydratedRouter
				// An error a route's error boundary caught while drawing a page: the
				// page shows the boundary, so nothing else would tell anyone. An error
				// in a loader or an action is logged on the server, and is not sent again.
				onError={(error, { pattern, errorInfo }) => {
					if (errorInfo) report("react", error, pattern);
				}}
			/>
		</StrictMode>,
	);
});
