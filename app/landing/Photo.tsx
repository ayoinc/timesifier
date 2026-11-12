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
	/** Classes for the figure: its place in the layout. */
	className?: string;
	/** Classes for the frame the photograph is cut to, when that is not its own shape. */
	frame?: string;
}

/**
 * A photograph with its place as the caption; who took it is credited at the
 * foot of the page (`SiteFooter`). The width and height hold its place before the
 * file arrives, so nothing below it moves; it is fetched when it nears the window.
 * Inside its frame it drifts a little against the page as the page is scrolled
 * (`drift` in public.css): the frame holds still and cuts off what passes its edge.
 */
export function Photo({ photo, alt, sizes, className, frame }: PhotoProps) {
	return (
		<figure className={cx("flex flex-col gap-2", className)}>
			<picture
				className={cx("block overflow-hidden rounded-extra-small bg-surface-container-high", frame)}
			>
				<source type="image/avif" srcSet={sources(photo, "avif")} sizes={sizes} />
				<source type="image/webp" srcSet={sources(photo, "webp")} sizes={sizes} />
				<img
					src={photoPath(photo, photo.width, "webp")}
					width={photo.width}
					height={photo.height}
					alt={alt}
					loading="lazy"
					decoding="async"
					className={cx("drift w-full", frame ? "h-full object-cover" : "h-auto")}
				/>
			</picture>
			<figcaption className="text-body-small text-on-surface-variant">{photo.place}.</figcaption>
		</figure>
	);
}
