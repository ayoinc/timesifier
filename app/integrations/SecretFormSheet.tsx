import { type ReactNode, useEffect, useId, useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { Sheet } from "~/components/Sheet";

/** What an action that makes a secret answers: the secret, shown this once, or why it was not made. */
export type SecretOutcome =
	| { ok: true; said: string; secret: string; secretLabel: string }
	| { ok: false; problem: string };

export interface SecretFormSheetProps {
	title: string;
	intent: string;
	submitLabel: string;
	isOpen: boolean;
	onClose: () => void;
	/** Called with what the server said once the person has seen the secret and closed the sheet. */
	onDone: (said: string) => void;
	children: ReactNode;
}

/**
 * A sheet whose form makes a secret: an API token, a webhook's signing secret
 * or a calendar feed's address (TS-081, TS-087, TS-089). It is the page's
 * FormSheet until the server answers; then it stays open and shows the
 * secret, which is never shown again, with a button that copies it, and Done.
 */
export function SecretFormSheet({
	title,
	intent,
	submitLabel,
	isOpen,
	onClose,
	onDone,
	children,
}: SecretFormSheetProps) {
	const form = useId();
	const secretId = useId();
	const fetcher = useFetcher<SecretOutcome>();
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const made = answer?.ok ? answer : null;
	const [copied, setCopied] = useState(false);

	const { reset } = fetcher;
	useEffect(() => {
		if (!isOpen) {
			reset();
			setCopied(false);
		}
	}, [isOpen, reset]);

	const close = () => {
		if (made) onDone(made.said);
		onClose();
	};

	return (
		<Sheet
			title={made ? made.secretLabel : title}
			isOpen={isOpen}
			// Shown once: a press outside must not lose it.
			isDismissable={!made}
			onOpenChange={(open) => {
				if (!open) close();
			}}
			actions={
				made ? (
					<Button slot="close">Done</Button>
				) : (
					<>
						<Button variant="text" slot="close">
							Cancel
						</Button>
						<Button type="submit" form={form} isPending={fetcher.state !== "idle"}>
							{submitLabel}
						</Button>
					</>
				)
			}
		>
			{made ? (
				<div className="flex flex-col gap-4">
					<p>Copy it now. It is shown this once; Timesifier keeps no copy it could show again.</p>
					<code
						id={secretId}
						className="block rounded-small border border-outline-variant bg-surface px-3 py-2 font-mono text-body-medium break-all text-on-surface select-all"
					>
						{made.secret}
					</code>
					<div className="flex items-center gap-3">
						<Button
							variant="outlined"
							aria-describedby={secretId}
							onPress={async () => {
								await navigator.clipboard?.writeText(made.secret);
								setCopied(true);
							}}
						>
							Copy
						</Button>
						<p role="status" className="text-body-medium text-on-surface-variant">
							{copied ? "Copied." : ""}
						</p>
					</div>
				</div>
			) : (
				<fetcher.Form
					id={form}
					method="post"
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						if (fetcher.state !== "idle") event.preventDefault();
					}}
				>
					<input type="hidden" name="intent" value={intent} />
					{children}
					<p role="alert" className="text-body-medium text-error empty:hidden">
						{answer && !answer.ok ? answer.problem : null}
					</p>
				</fetcher.Form>
			)}
		</Sheet>
	);
}
