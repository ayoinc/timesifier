// Ordinary code that looks a little like a raw value and must pass.
export type Totals = { [day: string]: number };
export type Flags = Record<string, boolean> & { [key: `data-${string}`]: boolean };

export function firstAndLast(rows: number[][], index: number) {
	const first = rows[0];
	const last = rows[rows.length - 1];
	return [first?.[index], last?.[index - 1]];
}

export const links = {
	help: "https://timesifier.example/help#faq",
	section: "/reports#add",
	anchor: { href: "#feed" },
	issue: "See pull request 123 and section 4.2",
};

export class Counter {
	#add = 1;

	#bed() {
		return this.#add;
	}

	next() {
		return this.#bed() + 1;
	}
}

export const entity = "&#169; Timesifier";
export const dayNames = /^[a-z]+(?:-[a-z]+)*$/;
