import { useId, useRef, useState } from "react";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { FormSheet } from "~/routes/app/FormSheet";
import { Section } from "~/shell/PageHeading";

import { contrastWithWhite, HEX_COLOUR, LEAST_CONTRAST, normaliseColour } from "./colour";
import { needsRendition, rendition } from "./rendition";
import type { BrandData } from "./settings.server";

/** What the file field offers: the four kinds a logo may be. */
const LOGO_ACCEPT = ".png,.svg,.jpg,.jpeg,.webp,image/png,image/svg+xml,image/jpeg,image/webp";
/** The longest side of the PNG drawn from an SVG or a WebP. */
const RENDITION_SIDE = 512;

/**
 * Workspace settings' Brand (TS-100): the organisation's logo and colour, which
 * lead the invoices and estimates it sends, their PDFs and emails, and the
 * estimate's page, and stand beside its name in the band of every page. Only
 * owners and admins reach this page; everyone in the organisation sees the logo.
 */
export function BrandSettings({
	data,
	organisationName,
	onDone,
}: {
	data: BrandData;
	organisationName: string;
	onDone: (said: string) => void;
}) {
	const [task, setTask] = useState<"logo" | "remove-logo" | "colour" | null>(null);
	const close = () => setTask(null);
	const fileId = useId();
	const hintId = useId();
	const renditionField = useRef<HTMLInputElement>(null);
	const [typed, setTyped] = useState(data.colour ?? "");
	const colour = normaliseColour(typed);
	const valid = HEX_COLOUR.test(colour);
	const contrast = valid ? contrastWithWhite(colour) : null;

	/** For an SVG or a WebP, the PNG the server keeps beside it; nothing for the rest. */
	const prepare = async (input: HTMLInputElement) => {
		const field = renditionField.current;
		if (!field) return;
		const transfer = new DataTransfer();
		const file = input.files?.[0];
		if (file && needsRendition(file)) {
			const drawn = await rendition(file, RENDITION_SIDE, "logo.png").catch(() => null);
			if (drawn) transfer.items.add(drawn);
		}
		field.files = transfer.files;
	};

	return (
		<Section
			id="brand"
			heading="Brand"
			lead={`The logo and colour that lead the invoices and estimates ${organisationName} sends, their PDFs and emails. The logo stands beside the organisation's name at the top of every page, for everyone in it.`}
			className="max-w-200"
		>
			<Ledger heading="Brand">
				<LedgerRows>
					<LedgerRow
						title={
							data.logo ? (
								<span className="inline-flex rounded-small border border-outline-variant bg-surface p-2">
									<img
										src={data.logo.path}
										alt={`The logo of ${organisationName}`}
										className="h-12 w-auto max-w-48 object-contain"
									/>
								</span>
							) : (
								"No logo"
							)
						}
						detail={
							data.logo
								? `Logo, a ${data.logo.kind}. Documents lead with it; without one, with the name alone.`
								: "Logo. Documents lead with the organisation's name alone until it has one."
						}
						action={
							<span className="flex flex-wrap justify-end gap-1">
								<Button
									variant="text"
									aria-label={data.logo ? "Replace the logo" : "Upload a logo"}
									onPress={() => setTask("logo")}
								>
									{data.logo ? "Replace" : "Upload"}
								</Button>
								{data.logo && (
									<Button
										variant="text"
										aria-label="Remove the logo"
										onPress={() => setTask("remove-logo")}
									>
										Remove
									</Button>
								)}
							</span>
						}
					/>
					<LedgerRow
						title={
							data.colour ? (
								<span className="inline-flex items-center gap-3">
									<Swatch colour={data.colour} />
									<span className="font-mono">{data.colour}</span>
								</span>
							) : (
								"No colour"
							)
						}
						detail="Colour. A band across the top of each document and the button in its email, with white words on it."
						action={
							<Button
								variant="text"
								aria-label="Change the colour"
								onPress={() => {
									setTyped(data.colour ?? "");
									setTask("colour");
								}}
							>
								Change
							</Button>
						}
					/>
				</LedgerRows>
			</Ledger>

			<FormSheet
				title={data.logo ? "Replace the logo" : "Upload a logo"}
				intent="brand-logo"
				submitLabel="Save logo"
				encType="multipart/form-data"
				isOpen={task === "logo"}
				onClose={close}
				onDone={onDone}
			>
				<div className="flex flex-col gap-1">
					<label htmlFor={fileId} className="text-body-medium text-on-surface">
						Logo
					</label>
					<input
						id={fileId}
						type="file"
						name="logo"
						accept={LOGO_ACCEPT}
						required
						aria-describedby={hintId}
						onChange={(event) => void prepare(event.currentTarget)}
						className="rounded-extra-small text-body-medium text-on-surface-variant outline-none focus-visible:focus-indicator file:me-4 file:h-10 file:cursor-pointer file:rounded-large-increased file:border file:border-outline-variant file:border-solid file:bg-transparent file:px-4 file:text-label-large file:text-primary"
					/>
					<span id={hintId} className="text-body-small text-on-surface-variant">
						A PNG, SVG, JPEG or WebP of up to 256 KB, from 16 to 2,048 pixels on each side. An SVG
						with a script, an animation or a link to another file is refused.
					</span>
				</div>
				{/* The PNG drawn from an SVG or a WebP, filled in by the field above. */}
				<input
					ref={renditionField}
					type="file"
					name="rendition"
					hidden
					tabIndex={-1}
					aria-hidden="true"
				/>
			</FormSheet>

			<FormSheet
				title="Remove the logo"
				intent="remove-logo"
				submitLabel="Remove logo"
				submitVariant="danger"
				isOpen={task === "remove-logo"}
				onClose={close}
				onDone={onDone}
			>
				<p>
					Documents and their emails will lead with {organisationName}'s name alone, and the band
					will show the name without the logo.
				</p>
			</FormSheet>

			<FormSheet
				title="Change the colour"
				intent="brand-colour"
				submitLabel="Save colour"
				isSubmitDisabled={typed.trim() !== "" && (contrast === null || contrast < LEAST_CONTRAST)}
				isOpen={task === "colour"}
				onClose={close}
				onDone={onDone}
			>
				<TextField
					label="Colour"
					name="colour"
					value={typed}
					onChange={setTyped}
					maxLength={7}
					autoComplete="off"
					description="# and six hexadecimal digits. White words stand on it, so it must be dark enough for them. Leave it empty for none."
				/>
				<p
					className="flex items-center gap-3 text-body-medium text-on-surface-variant"
					aria-live="polite"
				>
					{typed.trim() === "" ? (
						"No colour: documents keep the product's."
					) : contrast === null ? (
						"Not a colour yet."
					) : (
						<>
							<Swatch colour={colour} />
							<span>
								White on it: {contrast.toFixed(1)} to 1.{" "}
								{contrast < LEAST_CONTRAST
									? `Too light: it needs at least ${LEAST_CONTRAST} to 1.`
									: "Dark enough."}
							</span>
						</>
					)}
				</p>
			</FormSheet>
		</Section>
	);
}

/** A square of `colour` with white letters on it, as a document shows them. */
function Swatch({ colour }: { colour: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 40 24"
			className="h-6 w-10 shrink-0 rounded-extra-small"
		>
			<rect width="40" height="24" rx="4" fill={colour} />
			<text x="20" y="16.5" textAnchor="middle" fontSize="12" fontWeight="600" fill="white">
				Aa
			</text>
		</svg>
	);
}
