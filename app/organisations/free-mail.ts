/**
 * Mail domains anybody can have an address at (TS-104 slice 104c). None can be
 * an organisation's verified domain: the people who sign in with an address
 * there are not one company's. Kept by hand, in alphabetical order; a domain
 * below a listed one (`mail.yahoo.co.uk` under `yahoo.co.uk`) is refused too.
 *
 * The list holds the providers' own domains and their national ones where
 * they give out addresses (Gmail, Outlook and Hotmail, Yahoo, iCloud, Proton,
 * AOL, GMX, Zoho, Yandex, Mail.ru, Tutanota, Fastmail and the like), and the
 * large internet providers' mail in the United Kingdom.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
	"aim.com",
	"aol.co.uk",
	"aol.com",
	"att.net",
	"bigpond.com",
	"btinternet.com",
	"comcast.net",
	"duck.com",
	"fastmail.com",
	"fastmail.fm",
	"gmail.com",
	"gmx.co.uk",
	"gmx.com",
	"gmx.de",
	"gmx.net",
	"googlemail.com",
	"hey.com",
	"hotmail.co.uk",
	"hotmail.com",
	"hotmail.de",
	"hotmail.fr",
	"icloud.com",
	"inbox.com",
	"live.co.uk",
	"live.com",
	"mac.com",
	"mail.com",
	"mail.ru",
	"me.com",
	"msn.com",
	"ntlworld.com",
	"outlook.co.uk",
	"outlook.com",
	"outlook.de",
	"outlook.fr",
	"pm.me",
	"proton.me",
	"protonmail.ch",
	"protonmail.com",
	"qq.com",
	"rocketmail.com",
	"sky.com",
	"talktalk.net",
	"tuta.io",
	"tutanota.com",
	"verizon.net",
	"virginmedia.com",
	"web.de",
	"yahoo.co.uk",
	"yahoo.com",
	"yahoo.de",
	"yahoo.fr",
	"yandex.com",
	"yandex.ru",
	"ymail.com",
	"zoho.com",
	"zohomail.com",
];

const LISTED = new Set(FREE_MAIL_DOMAINS);

/** Whether `domain` (lower case) is a free mail domain, or below one. */
export function isFreeMailDomain(domain: string): boolean {
	const labels = domain.split(".");
	for (let at = 0; at < labels.length - 1; at++) {
		if (LISTED.has(labels.slice(at).join("."))) return true;
	}
	return false;
}
