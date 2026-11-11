/**
 * The timer's control at the top of the navigation, before its first heading
 * (docs/navigation.md, "The navigation, top to bottom"; TS-051). With nothing
 * running it will read "Start timer"; with an entry running it will show the
 * project, the time elapsed and "Stop".
 *
 * Until the control is built it draws nothing at all, so nobody meets a
 * control that does nothing. `Navigation` renders it in its place, and the
 * card that builds it fills this component in and nothing else in the shell.
 */
export function NavigationTimer(_: { organisation: string }) {
	return null;
}
