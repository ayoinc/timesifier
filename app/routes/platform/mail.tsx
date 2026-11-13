import { env } from "cloudflare:workers";
import { useState } from "react";
import {
	TextField as AriaTextField,
	FieldError,
	Label,
	Text,
	TextArea,
} from "react-aria-components";
import { useFetcher } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import {
	FIELD_CONTROL,
	FIELD_ERROR,
	fieldIndicator,
	fieldLabel,
	fieldSupporting,
} from "~/components/field";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { TextField } from "~/components/TextField";
import { platformData } from "~/db";
import { parseRequest } from "~/lib/validate";
import { declined, done } from "~/organisations/outcome.server";
import { nameOrEmail } from "~/organisations/people";
import type { Outcome } from "~/organisations/problems";
import { consoleMoment } from "~/platform/console-words";
import { MAIL_KIND_LABELS, type MailKind, mailingEmail } from "~/platform/emails";
import { platformOwnerContext } from "~/platform/guard.server";
import { DAILY_MAIL_CAP, MAIL_BATCH, mailOrigin, unsubscribePath } from "~/platform/mail.server";
import { FormSheet } from "~/routes/app/FormSheet";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/mail";

// Mail to account holders in the platform console (TS-099, decision 36). A
// platform owner writes a product announcement, which goes to every open
// account that has not turned them off, or a newsletter, which goes only to
// those who asked for it. A preview shows the message as it will be read;
// queueing makes one waiting delivery for each person it goes to now, and the
// minute's scheduled work sends them within the caps (app/platform/mail.server.ts).

const HEADING = "Mail";

const SUBJECT_MAX_LENGTH = 150;
const BODY_MAX_LENGTH = 10_000;

const KINDS = ["announcement", "newsletter"] as const satisfies readonly MailKind[];

const Mailing = {
	kind: z.enum(KINDS),
	subject: z.string().trim().min(1).max(SUBJECT_MAX_LENGTH),
	body: z.string().trim().min(1).max(BODY_MAX_LENGTH),
};

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("preview"), ...Mailing }),
	z.object({ intent: z.literal("queue"), ...Mailing }),
]);

/** A preview: the message as one person would get it, which nobody is sent. */
type Previewed = { ok: true; said: string; preview: { subject: string; text: string } };

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

export async function loader() {
	const [announcement, newsletter, mailings] = await Promise.all([
		platformData.audienceSize(env.DB, "announcement"),
		platformData.audienceSize(env.DB, "newsletter"),
		platformData.mailingList(env.DB),
	]);
	return {
		audience: { announcement, newsletter } satisfies Record<MailKind, number>,
		cap: { day: DAILY_MAIL_CAP, minute: MAIL_BATCH },
		mailings: mailings.map((mailing) => ({
			id: mailing.id,
			subject: mailing.subject,
			kind:
				mailing.kind === "newsletter" ? MAIL_KIND_LABELS.newsletter : MAIL_KIND_LABELS.announcement,
			// A sender whose account has gone is no longer anybody to name.
			sender:
				mailing.senderEmail === null
					? "A former platform owner"
					: nameOrEmail({ name: mailing.sender, email: mailing.senderEmail }),
			when: consoleMoment(mailing.createdAt),
			recipients: mailing.recipients,
			sent: mailing.sent,
			waiting: mailing.waiting,
		})),
	};
}

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const owner = context.get(platformOwnerContext);
	const { kind, subject, body } = input;

	if (input.intent === "preview") {
		// The platform owner's own unsubscribe link stands in for each person's.
		const message = mailingEmail({
			kind,
			subject,
			body,
			unsubscribe: `${mailOrigin(request)}${await unsubscribePath(kind, owner.user.id)}`,
		});
		return {
			ok: true,
			said: "This is how it reads. Nothing was sent or queued.",
			preview: { subject: message.subject, text: message.text },
		} satisfies Previewed;
	}

	if ((await platformData.audienceSize(env.DB, kind)) === 0) {
		return declined(
			`Nobody has ${MAIL_KIND_LABELS[kind].toLowerCase()}s on. Nothing was queued.`,
			409,
		);
	}
	const mailing = await platformData.createMailing(env.DB, {
		kind,
		subject,
		body,
		sentBy: owner.user.id,
	});
	await platformData.recordPlatformEvent(env.DB, {
		actorId: owner.user.id,
		action: "mailing.queued",
		subjectType: "mailing",
		subjectId: mailing.id,
		detail: { kind, subject, recipients: mailing.recipients },
	});
	return done(
		`Queued “${subject}” to ${people(mailing.recipients)}. It goes out over the next minutes, ${DAILY_MAIL_CAP} a day at most.`,
	);
}

/** "1 person", "12 people". */
function people(n: number): string {
	return n === 1 ? "1 person" : `${n} people`;
}

export default function Mail({ loaderData }: Route.ComponentProps) {
	const { audience, cap, mailings } = loaderData;
	const [kind, setKind] = useState<MailKind>("announcement");
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [isQueueing, setIsQueueing] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const preview = useFetcher<Previewed | Outcome>();
	const previewed =
		preview.state === "idle" && preview.data && "preview" in preview.data
			? preview.data.preview
			: null;
	const reach = audience[kind];
	const isWritten = subject.trim() !== "" && body.trim() !== "";

	return (
		<>
			<PageHeading>{HEADING}</PageHeading>
			<PageLead>
				Write to the people with a Timesifier account. Product announcements go to every open
				account that has not turned them off; the newsletter only to people who asked for it. Each
				message carries a link that stops that kind of mail in one press.
			</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section
				id="write"
				heading="Write a mailing"
				lead={`Messages go out ${cap.minute} a minute and ${cap.day} a day at most, so a large mailing takes more than a day.`}
				className="max-w-200"
			>
				<preview.Form method="post" className="flex flex-col gap-6">
					<input type="hidden" name="intent" value="preview" />
					<RadioGroup
						label="Kind of mail"
						name="kind"
						value={kind}
						onChange={(value) => setKind(value === "newsletter" ? "newsletter" : "announcement")}
						isRequired
					>
						{KINDS.map((each) => (
							<Radio key={each} value={each}>
								{MAIL_KIND_LABELS[each]}, to {people(audience[each])}
							</Radio>
						))}
					</RadioGroup>
					<TextField
						label="Subject"
						name="subject"
						value={subject}
						onChange={setSubject}
						autoComplete="off"
						isRequired
						maxLength={SUBJECT_MAX_LENGTH}
						description="Also the message's heading."
					/>
					<MessageField value={body} onChange={setBody} />
					<div className="flex flex-wrap gap-2">
						<Button type="submit" variant="outlined" isDisabled={!isWritten}>
							Preview
						</Button>
						<Button isDisabled={!isWritten || reach === 0} onPress={() => setIsQueueing(true)}>
							Queue mailing
						</Button>
					</div>
					{preview.state === "idle" && preview.data && !preview.data.ok && (
						<p role="alert" className="text-body-medium text-error">
							{preview.data.problem}
						</p>
					)}
				</preview.Form>

				{previewed && (
					<section
						aria-labelledby="preview"
						className="mt-6 rounded-large bg-surface-container p-4 text-on-surface"
					>
						<h3 id="preview" className="text-title-medium">
							Preview: {previewed.subject}
						</h3>
						<p className="mt-1 text-body-medium text-on-surface-variant">
							The plain-text version, as one person would get it. Nothing was sent or queued.
						</p>
						<pre className="mt-4 font-sans text-body-medium wrap-anywhere whitespace-pre-wrap">
							{previewed.text}
						</pre>
					</section>
				)}
			</Section>

			{mailings.length === 0 ? (
				<EmptySheet heading="Mailings">Nothing has been sent yet.</EmptySheet>
			) : (
				<Section id="mailings" heading="Mailings" lead="Newest first." className="max-w-200">
					<Ledger heading="Sent and sending" note={mailings.length}>
						<LedgerRows>
							{mailings.map((mailing) => (
								<LedgerRow
									key={mailing.id}
									title={<span className="wrap-anywhere">{mailing.subject}</span>}
									detail={
										<>
											{mailing.kind}, from {mailing.sender}, {mailing.when}.
											<span className="block">
												{mailing.sent} of {people(mailing.recipients)} sent
												{mailing.waiting > 0 ? `, ${mailing.waiting} waiting` : ""}.
											</span>
										</>
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</Section>
			)}

			<FormSheet
				title={`Queue to ${people(reach)}?`}
				intent="queue"
				submitLabel="Queue mailing"
				isOpen={isQueueing}
				onClose={() => setIsQueueing(false)}
				onDone={(text) => {
					setSaid(text);
					setSubject("");
					setBody("");
					preview.reset();
				}}
			>
				<input type="hidden" name="kind" value={kind} />
				<input type="hidden" name="subject" value={subject} />
				<input type="hidden" name="body" value={body} />
				<p>
					“{subject.trim()}” goes to everyone with {MAIL_KIND_LABELS[kind].toLowerCase()}s on, as
					they are now. Once queued it cannot be called back; anyone who turns this kind of mail off
					or whose account closes before their turn is skipped.
				</p>
			</FormSheet>
		</>
	);
}

/**
 * The message, several lines long: TextField's filled style, grown to hold
 * paragraphs. A blank line between two paragraphs is what separates them.
 */
function MessageField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	return (
		<AriaTextField
			name="body"
			value={value}
			onChange={onChange}
			isRequired
			maxLength={BODY_MAX_LENGTH}
			className="flex flex-col gap-1"
		>
			{(field) => (
				<>
					<div
						className={cx(
							"group/field relative",
							field.isDisabled ? "text-disabled" : "text-on-surface",
						)}
					>
						<TextArea
							rows={10}
							className={cx(
								FIELD_CONTROL,
								"block resize-y px-4 pt-7 pb-2 text-body-large",
								field.isInvalid ? "caret-error" : "caret-primary",
							)}
						/>
						<Label className={cx(fieldLabel(field), "end-4")}>
							Message
							<span aria-hidden="true"> *</span>
						</Label>
						<span className={fieldIndicator(field)} />
					</div>
					{!field.isInvalid && (
						<Text slot="description" className={fieldSupporting(field)}>
							Paragraphs separated by a blank line. Plain text: no formatting or links of your own.
						</Text>
					)}
					<FieldError className={FIELD_ERROR} />
				</>
			)}
		</AriaTextField>
	);
}
