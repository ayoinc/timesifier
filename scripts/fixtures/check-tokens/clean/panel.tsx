// Token-backed utilities and bracketed variants must pass.
export function Panel({ items }: { items: string[] }) {
	return (
		<section className="rounded-medium bg-surface-container p-4 text-body-large shadow-level1">
			<a className="text-primary data-[state=open]:bg-primary-container" href="#add">
				{items[0]}
			</a>
			<p className="bg-primary/50 duration-short4 ease-emphasized">{items[items.length - 1]}</p>
		</section>
	);
}
