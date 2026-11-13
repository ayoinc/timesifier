import { toBase64 } from "./images";

/** Whether `file` is one a mail program or a PDF cannot show, and the browser draws as a PNG. */
export function needsRendition(file: File): boolean {
	return /svg|webp/i.test(file.type || file.name);
}

/**
 * An SVG or a WebP drawn as a PNG, for the mail programs and PDFs that cannot
 * show either. It is drawn by an image element from a data address, where an
 * SVG runs nothing, at most `side` pixels on its longest side, into a file
 * called `name`. Null where the browser cannot draw it.
 */
export async function rendition(file: File, side: number, name: string): Promise<File | null> {
	const image = new Image();
	image.src = `data:${file.type || "image/svg+xml"};base64,${toBase64(new Uint8Array(await file.arrayBuffer()))}`;
	try {
		await image.decode();
	} catch {
		return null;
	}
	const natural = {
		width: image.naturalWidth || side,
		height: image.naturalHeight || side,
	};
	const scale = side / Math.max(natural.width, natural.height);
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(natural.width * scale));
	canvas.height = Math.max(1, Math.round(natural.height * scale));
	canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
	// The app's library predates `Promise.withResolvers`; `toBlob` answers by callback.
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	return blob ? new File([blob], name, { type: "image/png" }) : null;
}
