import * as z from "zod";

/**
 * The TXT records at a name, asked of Cloudflare's public resolver over DNS
 * over HTTPS (TS-104 slice 104c). It is the resolver `node:dns` uses in a
 * Worker; it is asked directly, in its JSON form, so a test answers it the way
 * every other outside service is answered here, by standing in for `fetch`.
 * https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
 */
export const RESOLVER = "https://cloudflare-dns.com/dns-query";

/** DNS's record type number for TXT (RFC 1035). */
const TXT = 16;
/** The resolver's `Status`: the name has records, or it does not exist (RFC 1035 RCODEs 0 and 3). */
const NOERROR = 0;
const NXDOMAIN = 3;

const Answer = z.object({
	Status: z.number(),
	Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

/** A TXT record's data as the resolver writes it, `"part" "part"`, read as the one string it stands for. */
function textOf(data: string): string {
	const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
	if (!parts) return data;
	return parts.map((part) => part.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/**
 * The TXT records at `name`: an empty list where it has none or does not
 * exist, and `null` where the resolver could not say, so a failure to ask is
 * never read as the record being gone.
 */
export async function txtRecords(name: string): Promise<string[] | null> {
	try {
		const response = await fetch(`${RESOLVER}?${new URLSearchParams({ name, type: "TXT" })}`, {
			headers: { accept: "application/dns-json" },
		});
		if (!response.ok) return null;
		const answer = Answer.safeParse(await response.json());
		if (!answer.success) return null;
		if (answer.data.Status === NXDOMAIN) return [];
		if (answer.data.Status !== NOERROR) return null;
		return (answer.data.Answer ?? [])
			.filter((record) => record.type === TXT)
			.map((record) => textOf(record.data));
	} catch {
		return null;
	}
}
