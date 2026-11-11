import { cx } from "~/components/cx";

import { type PhotoFormat, type PhotoSource, photoPath } from "./photos";

function sources(photo: PhotoSource, format: PhotoFormat): string {
	return photo.widths.map((width) => `${photoPath(photo, width, format)} ${width}w`).join(", ");
}

export interface PhotoProps {
	photo: PhotoSource;
	/** What the photograph shows, for someone who cannot see it. */
	alt: string;
	/** How wide it is drawn at each window size, as the `sizes` attribute. */
	sizes: string;
	/** Where it is and who took it, set under the photograph. */
	caption: string;
	className?: string;
}

/**
 * A photograph with its caption. The width and height hold its place before the
 * file arrives, so nothing below it moves; it is fetched when it nears the window.
 */
export function Photo({ photo, alt, sizes, caption, className }: PhotoProps) {
	return (
		<figure className={cx("flex flex-col gap-2", className)}>
			<picture>
				<source type="image/avif" srcSet={sources(photo, "avif")} sizes={sizes} />
				<source type="image/webp" srcSet={sources(photo, "webp")} sizes={sizes} />
				<img
					src={photoPath(photo, photo.width, "webp")}
					width={photo.width}
					height={photo.height}
					alt={alt}
					loading="lazy"
					decoding="async"
					className="h-auto w-full rounded-extra-small bg-surface-container-high"
				/>
			</picture>
			<figcaption className="text-body-small text-on-surface-variant">{caption}</figcaption>
		</figure>
	);
}
