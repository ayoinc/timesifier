// The frame of a signed-in page that is in no organisation: the chooser, the
// page that creates an organisation, and an invitation's page. There is nothing
// to navigate, so the product's name stands at the top of one narrow column.

/** The column: the product's name, the page, and whatever stands at its foot. */
export const OUTSIDE_FRAME =
	"mx-auto flex min-h-dvh w-full max-w-110 flex-col gap-10 px-4 pt-12 pb-8 medium:pt-24";

/** The product's name, which leads home. A plain link: the home page is loaded whole. */
export function ProductName() {
	return (
		<header>
			<a
				href="/"
				className="rounded-extra-small font-brand text-title-large text-primary outline-none focus-visible:focus-indicator"
			>
				Timesifier
			</a>
		</header>
	);
}
