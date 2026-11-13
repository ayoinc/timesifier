import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { PRODUCT } from "~/auth/email-frame";
import {
	HEX_COLOUR,
	LEAST_CONTRAST,
	normaliseColour,
	platformColourContrast,
} from "~/brand/colour";
import { toBase64 } from "~/brand/images";
import {
	IMAGE_SIDE,
	MOST_CHARACTERS,
	MOST_IMAGE_BYTES,
	PLATFORM_IMAGE_NAMES,
	type PlatformImageName,
} from "~/brand/platform-brand-limits";
import { needsRendition, rendition } from "~/brand/rendition";
import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { cx } from "~/components/cx";
import { TextField } from "~/components/TextField";
import { parseRequest } from "~/lib/validate";
import type { Outcome } from "~/organisations/problems";
import {
	BRAND_FORM_MAX_BYTES,
	BrandForm,
	brandAction,
	brandPageData,
	type Refused,
	type ShownImage,
} from "~/platform/brand.server";
import { platformOwnerContext } from "~/platform/guard.server";
import { BRAND_TESTS_PER_HOUR } from "~/platform/limits";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { EMAIL_COLOURS } from "~/styles/email-colours";

import type { Route } from "./+types/brand";

// The platform's brand in the console (TS-120, decision 45): what every message
// Timesifier sends in its own name carries, and the mark beside "Made with
// Timesifier" on what an organisation sends. The preview is drawn from the
// form as it is typed; the test email is drawn from what is saved.

const HEADING = "Brand";

/** What each image field offers: a PNG, or an SVG or a WebP the browser draws as one. */
const IMAGE_ACCEPT = ".png,.svg,.webp,image/png,image/svg+xml,image/webp";

/** Each image: its label, where it is used, its ground, and the side the browser draws an SVG or WebP at. */
const IMAGES: Record<
	PlatformImageName,
	{ label: string; use: string; ground: "light" | "dark"; side: number }
> = {
	logo: {
		label: "Logo",
		use: "At the top of every message Timesifier sends in its own name, beside the name, 28 pixels tall.",
		ground: "light",
		side: 112,
	},
	logoDark: {
		label: "Logo for dark grounds",
		use: "Kept for a dark ground. Messages are drawn on paper, so nothing Timesifier sends carries it yet.",
		ground: "dark",
		side: 112,
	},
	markLight: {
		label: "Mark",
		use: "Beside “Made with Timesifier” at the foot of an organisation's messages and PDFs, 14 pixels tall.",
		ground: "light",
		side: 96,
	},
	markDark: {
		label: "Mark for dark grounds",
		use: "Kept for a dark ground. Nothing Timesifier sends carries it yet.",
		ground: "dark",
		side: 96,
	},
};

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

export async function loader({ context }: Route.LoaderArgs) {
	return brandPageData(context.get(platformOwnerContext));
}

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, BrandForm, { maxBytes: BRAND_FORM_MAX_BYTES });
	return brandAction(input, context.get(platformOwnerContext));
}

type Texts = Route.ComponentProps["loaderData"]["texts"];
/** What one image field holds in the browser: a picked image to show, and whether the built-in one is asked for. */
type Picked = { src: string | null; builtIn: boolean };

/** A file as a `data:` address, which the page may show; the policy allows no `blob:` image. */
async function dataAddress(file: File): Promise<string> {
	return `data:${file.type || "image/png"};base64,${toBase64(new Uint8Array(await file.arrayBuffer()))}`;
}

export default function Brand({ loaderData }: Route.ComponentProps) {
	const { texts: saved, images, from, changed, testsTo, testsLeft } = loaderData;
	const save = useFetcher<Outcome | Refused>();
	const test = useFetcher<Outcome>();
	const [texts, setTexts] = useState<Texts>(saved);
	const [picked, setPicked] = useState<Record<PlatformImageName, Picked>>(nothingPicked);
	const [problems, setProblems] = useState<Refused["problems"]>({});
	const form = useRef<HTMLFormElement>(null);

	// What the save answered: the problems by field, and, once saved, the files let go.
	useEffect(() => {
		if (save.state !== "idle" || !save.data) return;
		if (save.data.ok) {
			setProblems({});
			setPicked(nothingPicked());
			for (const field of form.current?.querySelectorAll<HTMLInputElement>("input[type=file]") ??
				[]) {
				field.value = "";
			}
		} else if ("problems" in save.data) {
			setProblems(save.data.problems);
		}
	}, [save.state, save.data]);

	const typed = (field: keyof Texts) => (value: string) => {
		setTexts((now) => ({ ...now, [field]: value }));
		setProblems(({ [field]: _, ...rest }) => rest);
	};

	const colour = normaliseColour(texts.colour);
	const isColour = HEX_COLOUR.test(colour);
	const contrast = isColour ? platformColourContrast(colour, EMAIL_COLOURS) : null;
	const readable = contrast !== null && Math.max(contrast.ink, contrast.white) >= LEAST_CONTRAST;

	/** The image the preview shows for `name`: picked, built in, or saved. */
	const showing = (name: PlatformImageName): ShownImage | { src: string } => {
		const now = picked[name];
		if (now.builtIn) return images[name].builtIn;
		return now.src ? { src: now.src } : images[name].current;
	};

	const saidSave = save.state === "idle" && save.data ? save.data : null;
	const saidTest = test.state === "idle" && test.data ? test.data : null;

	return (
		<>
			<PageHeading>{HEADING}</PageHeading>
			<PageLead>
				What every message Timesifier sends in its own name carries: who it is from, where a reply
				goes, the band, the logo and the words at its foot. The mark also stands beside “Made with
				Timesifier” on what an organisation sends its clients.
				{changed
					? ` Last changed by ${changed.who}, ${changed.when}.`
					: " Nobody has changed it yet."}
			</PageLead>

			<div className="grid gap-x-10 lg:grid-cols-2">
				<save.Form ref={form} method="post" encType="multipart/form-data" className="flex flex-col">
					<input type="hidden" name="intent" value="save" />

					<Section id="sender" heading="Sender">
						<div className="flex flex-col gap-4">
							<TextField
								label="Sender name"
								name="senderName"
								value={texts.senderName}
								onChange={typed("senderName")}
								autoComplete="off"
								isRequired
								maxLength={MOST_CHARACTERS.senderName}
								description={`The name beside the address every message is from. At most ${MOST_CHARACTERS.senderName} characters, none of < > " @ , ; : or \\.`}
								isInvalid={problems.senderName !== undefined}
								errorMessage={problems.senderName}
							/>
							<TextField
								label="Reply-to"
								name="replyTo"
								type="email"
								value={texts.replyTo}
								onChange={typed("replyTo")}
								autoComplete="off"
								maxLength={MOST_CHARACTERS.replyTo}
								description="Where a reply goes. Leave it empty and a reply goes to the address the message is sent from."
								isInvalid={problems.replyTo !== undefined}
								errorMessage={problems.replyTo}
							/>
						</div>
					</Section>

					<Section id="words" heading="Words">
						<div className="flex flex-col gap-4">
							<TextField
								label="Tagline"
								name="tagline"
								value={texts.tagline}
								onChange={typed("tagline")}
								autoComplete="off"
								isRequired
								maxLength={MOST_CHARACTERS.tagline}
								description={`After the footer line, at the foot of every message. One line of at most ${MOST_CHARACTERS.tagline} characters.`}
								isInvalid={problems.tagline !== undefined}
								errorMessage={problems.tagline}
							/>
							<TextField
								label="Email footer"
								name="emailFooter"
								value={texts.emailFooter}
								onChange={typed("emailFooter")}
								autoComplete="off"
								isRequired
								maxLength={MOST_CHARACTERS.emailFooter}
								description={`The line at the foot of every message. One line of at most ${MOST_CHARACTERS.emailFooter} characters.`}
								isInvalid={problems.emailFooter !== undefined}
								errorMessage={problems.emailFooter}
							/>
						</div>
					</Section>

					<Section id="colour" heading="Colour">
						<div className="flex flex-col gap-3">
							<TextField
								label="Brand colour"
								name="colour"
								value={texts.colour}
								onChange={typed("colour")}
								autoComplete="off"
								isRequired
								maxLength={7}
								description={`# and six hexadecimal digits: the band at the top of every message. Ink or white must read on it at ${LEAST_CONTRAST} to 1, as ink reads on the amber.`}
								isInvalid={problems.colour !== undefined}
								errorMessage={problems.colour}
							/>
							<p
								className="flex items-center gap-3 text-body-medium text-on-surface-variant"
								aria-live="polite"
							>
								{contrast === null ? (
									"Not a colour yet."
								) : (
									<>
										<Swatch colour={colour} />
										<span>
											Ink on it: {contrast.ink.toFixed(1)} to 1. White on it:{" "}
											{contrast.white.toFixed(1)} to 1.{" "}
											{readable
												? "Readable."
												: `Neither reaches ${LEAST_CONTRAST} to 1: choose a lighter or a darker colour.`}
										</span>
									</>
								)}
							</p>
						</div>
					</Section>

					<Section
						id="images"
						heading="Logo and mark"
						lead={`Each a PNG of at most ${MOST_IMAGE_BYTES / 1024} KB, from ${IMAGE_SIDE.least} to ${IMAGE_SIDE.most.toLocaleString("en-GB")} pixels on each side. An SVG or a WebP is drawn as a PNG by your browser before it is sent. Messages carry each attached, never fetched.`}
					>
						<ul className="flex flex-col gap-6">
							{PLATFORM_IMAGE_NAMES.map((name) => (
								<ImageField
									key={name}
									name={name}
									image={showing(name)}
									isBuiltIn={
										picked[name].builtIn || (!picked[name].src && images[name].current.builtIn)
									}
									canUseBuiltIn={!images[name].current.builtIn || picked[name].src !== null}
									builtInAsked={picked[name].builtIn}
									problem={problems[name]}
									onPicked={(src) => {
										setPicked((now) => ({ ...now, [name]: { src, builtIn: false } }));
										setProblems(({ [name]: _, ...rest }) => rest);
									}}
									onBuiltIn={(builtIn) =>
										setPicked((now) => ({ ...now, [name]: { ...now[name], builtIn } }))
									}
								/>
							))}
						</ul>
					</Section>

					<div className="mt-10 flex flex-col gap-3">
						<div>
							<Button type="submit" isDisabled={save.state !== "idle" || !readable}>
								Save brand
							</Button>
						</div>
						<p role="status" className="text-body-medium text-on-surface-variant empty:hidden">
							{saidSave?.ok ? saidSave.said : ""}
						</p>
						<p role="alert" className="text-body-medium text-error empty:hidden">
							{saidSave && !saidSave.ok ? saidSave.problem : ""}
						</p>
					</div>
				</save.Form>

				<Section
					id="preview"
					heading="Preview"
					lead="As it is typed above, before it is saved. A message is drawn on paper in every colour scheme."
				>
					<EmailPreview
						texts={texts}
						colour={isColour ? colour : saved.colour}
						from={from}
						logo={showing("logo")}
					/>
					<h3 className="mt-6 text-title-medium">On each ground</h3>
					<div className="mt-3 grid grid-cols-2 gap-3">
						{(["light", "dark"] as const).map((ground) => (
							<Ground key={ground} ground={ground}>
								{PLATFORM_IMAGE_NAMES.filter((name) => IMAGES[name].ground === ground).map(
									(name) => (
										<img
											key={name}
											src={showing(name).src}
											alt={IMAGES[name].label}
											className={name.startsWith("logo") ? "h-7 w-auto" : "h-3.5 w-auto"}
										/>
									),
								)}
							</Ground>
						))}
					</div>
				</Section>
			</div>

			<Section
				id="test"
				heading="Send me a test email"
				lead={`The brand as saved, not as typed, in a message to ${testsTo}: the address you are signed in with, and nobody else. At most ${BRAND_TESTS_PER_HOUR} an hour; each is recorded in the log.`}
				className="max-w-200"
			>
				<test.Form method="post" className="flex flex-col gap-3">
					<input type="hidden" name="intent" value="test" />
					<div>
						<Button
							type="submit"
							variant="outlined"
							isDisabled={test.state !== "idle" || testsLeft <= 0}
						>
							Send me a test email
						</Button>
					</div>
					<p className="text-body-medium text-on-surface-variant">
						{testsLeft <= 0
							? `You have sent ${BRAND_TESTS_PER_HOUR} in the last hour. Try again later.`
							: `${testsLeft} of ${BRAND_TESTS_PER_HOUR} left this hour.`}
					</p>
					<p role="status" className="text-body-medium text-on-surface-variant empty:hidden">
						{saidTest?.ok ? saidTest.said : ""}
					</p>
					<p role="alert" className="text-body-medium text-error empty:hidden">
						{saidTest && !saidTest.ok ? saidTest.problem : ""}
					</p>
				</test.Form>
			</Section>
		</>
	);
}

function nothingPicked(): Record<PlatformImageName, Picked> {
	const none = { src: null, builtIn: false };
	return { logo: none, logoDark: none, markLight: none, markDark: none };
}

/**
 * One image of the brand: what it is shown as now, the file to replace it,
 * and the box that puts the built-in one back. An SVG or a WebP is drawn as a
 * PNG here and sent beside it, in the hidden field the server reads first.
 */
function ImageField({
	name,
	image,
	isBuiltIn,
	canUseBuiltIn,
	builtInAsked,
	problem,
	onPicked,
	onBuiltIn,
}: {
	name: PlatformImageName;
	image: { src: string };
	isBuiltIn: boolean;
	canUseBuiltIn: boolean;
	builtInAsked: boolean;
	problem: string | undefined;
	onPicked: (src: string | null) => void;
	onBuiltIn: (builtIn: boolean) => void;
}) {
	const { label, use, ground, side } = IMAGES[name];
	const fileId = useId();
	const hintId = useId();
	const problemId = useId();
	const png = useRef<HTMLInputElement>(null);
	const [drawing, setDrawing] = useState<string | null>(null);

	const choose = async (input: HTMLInputElement) => {
		const field = png.current;
		const file = input.files?.[0];
		const transfer = new DataTransfer();
		setDrawing(null);
		if (!file) {
			if (field) field.files = transfer.files;
			onPicked(null);
			return;
		}
		let shown = file;
		if (needsRendition(file)) {
			const drawn = await rendition(file, side, `${name}.png`).catch(() => null);
			if (drawn) {
				transfer.items.add(drawn);
				shown = drawn;
			} else {
				setDrawing("Your browser could not draw this file. Choose a PNG.");
			}
		}
		if (field) field.files = transfer.files;
		onPicked(await dataAddress(shown));
	};

	const said = problem ?? drawing;
	return (
		<li className="flex flex-col gap-2">
			<div className="flex items-center gap-4">
				<Ground ground={ground} small>
					<img
						src={image.src}
						alt=""
						className={name.startsWith("logo") ? "h-7 w-auto" : "h-3.5 w-auto"}
					/>
				</Ground>
				<div className="flex flex-col">
					<label htmlFor={fileId} className="text-title-small text-on-surface">
						{label}
					</label>
					<span className="text-body-small text-on-surface-variant">
						{isBuiltIn ? "The built-in one." : "Your own."}
					</span>
				</div>
			</div>
			<input
				id={fileId}
				type="file"
				name={name}
				accept={IMAGE_ACCEPT}
				disabled={builtInAsked}
				aria-describedby={cx(hintId, said ? problemId : "")}
				aria-invalid={said ? true : undefined}
				onChange={(event) => void choose(event.currentTarget)}
				className="rounded-extra-small text-body-medium text-on-surface-variant outline-none focus-visible:focus-indicator file:me-4 file:h-10 file:cursor-pointer file:rounded-large-increased file:border file:border-outline-variant file:border-solid file:bg-transparent file:px-4 file:text-label-large file:text-primary disabled:opacity-60"
			/>
			{/* The PNG drawn from an SVG or a WebP, filled in by the field above. */}
			<input ref={png} type="file" name={`${name}Png`} hidden tabIndex={-1} aria-hidden="true" />
			<span id={hintId} className="text-body-small text-on-surface-variant">
				{use}
			</span>
			{said && (
				<span id={problemId} className="text-body-small text-error">
					{said}
				</span>
			)}
			{canUseBuiltIn && (
				<Checkbox name={`${name}BuiltIn`} value="on" isSelected={builtInAsked} onChange={onBuiltIn}>
					Use the built-in {label.toLowerCase()}
				</Checkbox>
			)}
		</li>
	);
}

/** A ground of the scheme its images are for, whatever the page's own scheme. */
function Ground({
	ground,
	small = false,
	children,
}: {
	ground: "light" | "dark";
	small?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			data-color-scheme={ground}
			className={cx(
				"flex items-center gap-3 rounded-medium border border-outline-variant bg-surface text-on-surface",
				small ? "h-14 w-24 shrink-0 justify-center" : "min-h-20 flex-wrap justify-center p-4",
			)}
		>
			{children}
		</div>
	);
}

/**
 * The top and the foot of a message as `compose` draws them, in the light
 * scheme it is drawn in: the band, the logo and the name over the ink rule,
 * and the footer line and the tagline under the reason.
 */
function EmailPreview({
	texts,
	colour,
	from,
	logo,
}: {
	texts: Texts;
	colour: string;
	from: string | null;
	logo: { src: string };
}) {
	const sender = texts.senderName.trim() || "—";
	const replyTo = texts.replyTo.trim();
	return (
		<figure aria-label="Preview of a message" className="flex flex-col gap-3">
			<dl className="flex flex-col gap-1 text-body-medium">
				<div className="flex gap-3">
					<dt className="w-18 shrink-0 text-on-surface-variant">From</dt>
					<dd className="min-w-0 wrap-anywhere">
						{sender}
						{from ? ` <${from}>` : ""}
					</dd>
				</div>
				<div className="flex gap-3">
					<dt className="w-18 shrink-0 text-on-surface-variant">Reply-to</dt>
					<dd className="min-w-0 wrap-anywhere">
						{replyTo || "None: replies go to the sending address."}
					</dd>
				</div>
			</dl>
			<div
				data-color-scheme="light"
				className="overflow-hidden rounded-medium border border-outline-variant bg-surface text-on-surface"
			>
				<svg
					role="img"
					aria-label={`The band, in ${colour}`}
					viewBox="0 0 560 8"
					preserveAspectRatio="none"
					className="block h-2 w-full"
				>
					<rect width="560" height="8" fill={colour} />
				</svg>
				<div className="flex items-center gap-3 border-b-2 border-on-surface px-5 py-4">
					<img src={logo.src} alt="" className="h-7 w-auto" />
					<span className="font-brand text-headline-small">{PRODUCT}</span>
				</div>
				<p className="px-5 py-6 text-body-medium text-on-surface-variant">What the message says.</p>
				<div className="mx-5 border-t border-outline-variant pt-4 pb-6 text-body-small text-on-surface-variant">
					<p>Why the person got it.</p>
					<p className="mt-3 wrap-anywhere">
						{texts.emailFooter.trim()} {texts.tagline.trim()}
					</p>
				</div>
			</div>
		</figure>
	);
}

/** A square of `colour` with ink and white letters on it. */
function Swatch({ colour }: { colour: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 56 24"
			className="h-6 w-14 shrink-0 rounded-extra-small"
		>
			<rect width="56" height="24" rx="4" fill={colour} />
			<text
				x="16"
				y="16.5"
				textAnchor="middle"
				fontSize="12"
				fontWeight="600"
				fill={EMAIL_COLOURS.ink}
			>
				Aa
			</text>
			<text x="40" y="16.5" textAnchor="middle" fontSize="12" fontWeight="600" fill="white">
				Aa
			</text>
		</svg>
	);
}
