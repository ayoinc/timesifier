import { useNavigation } from "react-router";

/** What a submit button of a page's own `<Form>` is while the page is busy. */
export interface SubmitState {
	/** It sent the request on its way: it says what it is doing beside the WaitClock. */
	isPending: boolean;
	/** Another button sent one, or the page is moving: this one waits its turn. */
	isDisabled: boolean;
}

/**
 * The state of each submit button of a page's `<Form>` (docs/design-system.md,
 * "While the page waits"). Asked with the `name` and `value` the button sends,
 * it is pending while the request that carries them is on its way, and the
 * page loads what it answered; every other button is disabled until then, so
 * nothing is sent twice. Asked with nothing, the button is pending while any
 * form of the page is on its way: for a page with one.
 */
export function useSubmitting(): (name?: string, value?: string) => SubmitState {
	const navigation = useNavigation();
	const busy = navigation.state !== "idle";
	// A form sent by GET asks for a page, which the page's skeleton stands for.
	const sent = navigation.formMethod?.toUpperCase() === "GET" ? undefined : navigation.formData;
	return (name, value) => {
		const isPending = sent !== undefined && (name === undefined || sent.get(name) === value);
		return { isPending: busy && isPending, isDisabled: busy && !isPending };
	};
}
