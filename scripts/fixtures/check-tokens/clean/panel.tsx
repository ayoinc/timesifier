// Token-backed utilities, bracketed variants, and state read from the element
// itself, an ancestor or a sibling's pseudo-class must pass.
export function Panel({ items }: { items: string[] }) {
	return (
		<section className="rounded-medium bg-surface-container p-4 text-body-large shadow-level1">
			<a className="text-primary data-[state=open]:bg-primary-container" href="#add">
				{items[0]}
			</a>
			<p className="bg-primary/50 duration-short4 ease-emphasized">{items[items.length - 1]}</p>
			<p className="data-focused:text-primary group-has-data-focused/field:text-primary peer-placeholder-shown:top-4 peer-focus:top-2">
				{items.length}
			</p>
		</section>
	);
}
