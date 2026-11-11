// The outlines of the product's mark: a letter T cut on a slant into a top bar and
// a stem, with an arrowhead at its upper right. They were traced from the owner's
// 1254 x 1254 raster, not redrawn: each straight edge is a least-squares line through
// the edge's boundary pixels, each corner a circle fitted tangent to its two edges.
// The mark sits at 197.7, 332.8 in that raster and one unit here is one of its pixels,
// so the gaps between the three shapes are the ones the owner drew. Laid back over
// the raster, the outlines disagree with it on 0.06% of the pixels in the mark's box.
//
// The geometry lives apart from Mark.tsx because scripts/icons.ts draws the files
// under public/ from the same outlines. After a change here, run `pnpm icons`.

/** The size of a viewBox cropped tight to the mark, with no padding. */
export const MARK_WIDTH = 855.2;
export const MARK_HEIGHT = 631.1;

/** The top bar of the T. Its upper left and lower right corners are the wide ones. */
export const MARK_BAR =
	"M2.5 161.5L77.4 30.1A59.3 59.3 0 0 1 128.9 0.2L612.9 0.2A20.5 20.5 0 0 1 631.4 29.5L570.9 155.8A60.4 60.4 0 0 1 516.4 190.1L19.4 190.6A19.4 19.4 0 0 1 2.5 161.5Z";

/** The stem of the T, cut on nearly the same slant as the bar. */
export const MARK_STEM =
	"M155.5 597.5L294.6 262.5A65.9 65.9 0 0 1 355.3 221.8L515.1 221.6A19.2 19.2 0 0 1 532.9 248L390.1 602.3A46.1 46.1 0 0 1 347.3 631.1L177.9 631.1A24.3 24.3 0 0 1 155.5 597.5Z";

/** The arrowhead. Its right-hand corner, the one that points forward, is the wide one. */
export const MARK_ARROW =
	"M541.3 331.2L677.1 12.6A20.7 20.7 0 0 1 710.1 5.4L838.7 122.7A50.4 50.4 0 0 1 831.2 203L575 360.3A23.4 23.4 0 0 1 541.3 331.2Z";
