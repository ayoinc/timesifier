import type { ReactNode } from "react";

import { cx } from "../cx";

// Icons are Material Symbols (Rounded, weight 400), drawn from the SVG sources in
// github.com/google/material-design-icons at commit 10ecc14, licence Apache-2.0.
// One module per icon, so a page ships only the icons it uses. To add one, copy
// symbols/web/<name>/materialsymbolsrounded/<name>_24px.svg from that repository
// into a new module beside this one, keeping the path data as it is.

const SIZES = {
	/** 18px: inside a checkbox. */
	small: "size-4.5",
	/** 20px: beside a button label. */
	medium: "size-5",
	/** 24px: on its own. */
	large: "size-6",
} as const;

export interface IconProps {
	/** Drawn size. Defaults to `large`, 24px. */
	size?: keyof typeof SIZES;
	/** Extra classes for placement. The colour is the text colour around the icon. */
	className?: string;
}

/**
 * The frame every icon is drawn in. An icon is decoration and is hidden from
 * assistive technology: the control it sits in carries the accessible name.
 */
export function Icon({ size = "large", className, children }: IconProps & { children: ReactNode }) {
	return (
		<svg
			viewBox="0 -960 960 960"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
			className={cx("shrink-0", SIZES[size], className)}
		>
			{children}
		</svg>
	);
}
