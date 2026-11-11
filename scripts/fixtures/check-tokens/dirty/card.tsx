// Each line below breaks the token rule once; check-tokens.test.ts names them all.
export function Card() {
	return (
		<section style={{ color: "#1a2b3c" }}>
			<p className="w-[13px]">Width</p>
			<p className="bg-[#fff]">Background</p>
			<p className="hover:text-[color:red]">Text</p>
			<p className="[mask-type:luminance]">Mask</p>
			<p className="bg-primary/[0.5]">Opacity</p>
			<p className="min-[320px]:flex">Breakpoint</p>
		</section>
	);
}
