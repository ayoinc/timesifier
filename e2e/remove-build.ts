import { rmSync } from "node:fs";

// Runs once, after the last browser test. The build the tests ran against has the
// /design route in it. Removing it means the next deploy has to build again, and
// a normal build leaves the route out.
export default function removeBuild() {
	rmSync(new URL("../build", import.meta.url), { recursive: true, force: true });
}
