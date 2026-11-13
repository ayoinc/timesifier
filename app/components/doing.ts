// What a button says while the server has its request (docs/design-system.md,
// "While the page waits"): the verb of its label, as something being done.
// "Save" says "Saving…", "Send estimate" says "Sending…", "Write off" says
// "Writing off…". The words after the verb are dropped, so the waiting label is
// short and the button keeps its width.

/** Each verb a label starts with, longest first where one begins another. */
const DOING: ReadonlyArray<readonly [verb: string, doing: string]> = [
	["Write off", "Writing off"],
	["Take out", "Taking out"],
	["Set up", "Setting up"],
	["Switch on", "Switching on"],
	["Switch off", "Switching off"],
	["Accept", "Accepting"],
	["Add", "Adding"],
	["Apply", "Applying"],
	["Approve", "Approving"],
	["Archive", "Archiving"],
	["Cancel", "Cancelling"],
	["Check", "Checking"],
	["Create", "Creating"],
	["Decline", "Declining"],
	["Delete", "Deleting"],
	["Export", "Exporting"],
	["Import", "Importing"],
	["Invite", "Inviting"],
	["Invoice", "Invoicing"],
	["Issue", "Issuing"],
	["Join", "Joining"],
	["Leave", "Leaving"],
	["Lock", "Locking"],
	["Make", "Making"],
	["Open", "Opening"],
	["Pay", "Paying"],
	["Record", "Recording"],
	["Refuse", "Refusing"],
	["Remove", "Removing"],
	["Reopen", "Reopening"],
	["Request", "Requesting"],
	["Restore", "Restoring"],
	["Return", "Returning"],
	["Revert", "Reverting"],
	["Revoke", "Revoking"],
	["Save", "Saving"],
	["Send", "Sending"],
	["Set", "Setting"],
	["Share", "Sharing"],
	["Start", "Starting"],
	["Stop", "Stopping"],
	["Submit", "Submitting"],
	["Update", "Updating"],
	["Upload", "Uploading"],
	["Verify", "Verifying"],
	["Void", "Voiding"],
	["Withdraw", "Withdrawing"],
];

/**
 * The label a button shows while its request is on its way. A label whose verb
 * is not known says "Sending…", which is true of every form: it has been sent.
 */
export function doing(label: string): string {
	for (const [verb, form] of DOING) {
		if (label === verb || label.startsWith(`${verb} `)) return `${form}…`;
	}
	return "Sending…";
}
