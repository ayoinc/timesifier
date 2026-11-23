import { env } from "cloudflare:workers";
import { OPENAPI_PATH } from "~/integrations/paths";
import { BuyerPage } from "~/landing/BuyerPage";
import { MarkdownBlocks, parseMarkdown } from "~/landing/markdown";
import { deploymentOperator } from "~/landing/operator";
import { API_DOCS_PATH, LINK, PAGE, pageMeta, rootOrigin } from "~/landing/Site";
import apiReference from "../../docs/api.md?raw";

import type { Route } from "./+types/developers.api";

// The API reference (TS-106): docs/api.md, drawn when the application is
// built. The file is the one source; nothing here repeats its words. Its link
// to openapi.yaml, beside it in the repository, leads here to the description
// the application serves.

const BLOCKS = parseMarkdown(apiReference);
const TITLE = BLOCKS.find((block) => block.kind === "heading" && block.level === 1);
const SECTIONS = BLOCKS.flatMap((block) =>
	block.kind === "heading" && block.level === 2 ? [{ id: block.id, text: block.text }] : [],
);

/** Where a link in docs/api.md leads on the site. */
function siteHref(target: string): string {
	return target === "openapi.yaml" ? OPENAPI_PATH : target;
}

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: API_DOCS_PATH,
		title: "API reference · Timesifier",
		description:
			"The Timesifier API: tokens and scopes, the rate limit, every endpoint and what it returns, signed webhooks, calendar feeds, and CSV import and export.",
	});
}

/** The company that runs this deployment, which the foot names. */
export function loader() {
	return { operator: deploymentOperator(env) };
}

export default function ApiReference({ loaderData: { operator } }: Route.ComponentProps) {
	return (
		<BuyerPage
			path={API_DOCS_PATH}
			title={TITLE?.kind === "heading" ? TITLE.text : "The Timesifier API"}
			lead={
				<p>
					For developers: how to reach an organisation's data with a token, and how to be told when
					it changes.
				</p>
			}
			operator={operator}
			invite={false}
		>
			<div className={`${PAGE} grid gap-10 pt-10 pb-20 expanded:grid-cols-12 expanded:gap-8`}>
				<nav aria-labelledby="reference-contents" className="expanded:col-span-3">
					<div className="expanded:sticky expanded:top-28">
						<h2 id="reference-contents" className="text-label-large text-on-surface-variant">
							Contents
						</h2>
						<ul className="mt-3 flex flex-col text-body-large">
							{SECTIONS.map(({ id, text }) => (
								<li key={id}>
									<a href={`#${id}`} className={`${LINK} inline-block py-1`}>
										{text}
									</a>
								</li>
							))}
						</ul>
					</div>
				</nav>
				<article className="min-w-0 max-w-180 expanded:col-span-9">
					<MarkdownBlocks blocks={BLOCKS} href={siteHref} />
				</article>
			</div>
		</BuyerPage>
	);
}
