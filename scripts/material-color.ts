import { registerHooks } from "node:module";
import type * as Material from "@material/material-color-utilities";

// @material/material-color-utilities 0.4.0 ships ES modules whose internal imports
// omit the ".js" extension in ten files, which Node refuses to resolve. The hook adds
// the extension for that package only, for as long as the package is loading.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		const insidePackage = context.parentURL?.includes("/@material/material-color-utilities/");
		if (insidePackage && specifier.startsWith(".") && !specifier.endsWith(".js")) {
			return nextResolve(`${specifier}.js`, context);
		}
		return nextResolve(specifier, context);
	},
});

// A static import would be resolved before the hook above is registered.
export const material: typeof Material = await import("@material/material-color-utilities");

hooks.deregister();
