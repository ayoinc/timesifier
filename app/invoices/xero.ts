import { allocate } from "~/money/money";
import { moneyText } from "~/money/typed";
import { csvLine } from "~/reports/csv";
import type { Day } from "~/time/calendar";

import type { PricedLine, TaxRow } from "./documents.server";
import { quantityText } from "./lines";

/**
 * Issued invoices as a CSV in Xero's sales-invoice import format (TS-088),
 * for an organisation that books its sales in Xero before a connection to it
 * exists (TS-083). One row per line; rows with the same number are one
 * invoice in Xero. The columns are Xero's template's, in its order, with its
 * asterisks (`docs/research/harvest-b2b.md`, "Xero").
 *
 * The 27 headings are those of the template Xero offers under Sales ›
 * Invoices › Import, as Xero Central's "Import customer invoices" and a guide
 * checked against an Australian Xero organisation in October 2026 list them
 * (syslumelab.com/guides/xero-sales-invoice-import-csv). What remains
 * uncertain:
 * - Older copies of the template, and some regions', also had `Total` and
 *   `TaxAmount` columns. Xero's current template has neither, so Xero works
 *   each line's tax out from its `*TaxType` rate; on an invoice with several
 *   taxed lines its rounding may differ from ours by a penny.
 * - `*TaxType` must be the name of a tax rate in the Xero organisation. We
 *   write our tax's name, and `noTaxType` for a line with none; the person
 *   must name their taxes as Xero does.
 * - The file has no byte order mark: whether Xero's importer accepts one
 *   before the first heading is not documented.
 *
 * The person chooses "Tax exclusive" when importing: unit amounts are before
 * tax. The invoice's discount is shared between its lines (`allocate`) and
 * taken off their unit amounts, so the lines add up to the invoice's subtotal
 * after discount. A line whose quantity and price do not multiply exactly to
 * what it comes to is written as one of its amount.
 */
export const XERO_COLUMNS = [
	"*ContactName",
	"EmailAddress",
	"POAddressLine1",
	"POAddressLine2",
	"POAddressLine3",
	"POAddressLine4",
	"POCity",
	"PORegion",
	"POPostalCode",
	"POCountry",
	"*InvoiceNumber",
	"Reference",
	"*InvoiceDate",
	"*DueDate",
	"InventoryItemCode",
	"*Description",
	"*Quantity",
	"*UnitAmount",
	"Discount",
	"*AccountCode",
	"*TaxType",
	"TrackingName1",
	"TrackingOption1",
	"TrackingName2",
	"TrackingOption2",
	"Currency",
	"BrandingTheme",
] as const;

/** How the file writes a date: as the Xero organisation's region reads it. */
export type XeroDateOrder = "day-first" | "month-first";

/** A date as Xero reads it: "25/12/2026", or "12/25/2026" month first. */
export function xeroDate(day: Day, order: XeroDateOrder): string {
	const [year, month, date] = day.split("-");
	return order === "day-first" ? `${date}/${month}/${year}` : `${month}/${date}/${year}`;
}

/** An invoice as the export reads it. */
export interface XeroInvoice {
	number: string;
	clientName: string;
	email: string | null;
	poNumber: string | null;
	issuedOn: Day;
	dueOn: Day;
	currency: string;
	discountMinor: number;
	lines: (PricedLine & { description: string; quantityMilli: number; unitPriceMinor: number })[];
}

/** The choices the person makes for the file. */
export interface XeroOptions {
	accountCode: string;
	/** The Xero tax rate of a line that bears no tax, such as "No VAT". */
	noTaxType: string;
	dateOrder: XeroDateOrder;
}

/** The choices the export makes when the address names none. */
export const DEFAULT_XERO_OPTIONS: XeroOptions = {
	// 200 is Sales in Xero's standard chart of accounts.
	accountCode: "200",
	noTaxType: "No VAT",
	dateOrder: "day-first",
};

/** The cells of each row of `invoice`, in the order of `XERO_COLUMNS`. */
export function xeroRows(
	invoice: XeroInvoice,
	taxes: readonly Pick<TaxRow, "id" | "name">[],
	options: XeroOptions,
): string[][] {
	const { lines, currency } = invoice;
	const amounts = lines.map((line) => line.amountMinor);
	const discounts =
		invoice.discountMinor > 0 && amounts.some((amount) => amount > 0)
			? allocate(invoice.discountMinor, amounts)
			: amounts.map(() => 0);
	const taxName = new Map(taxes.map((tax) => [tax.id, tax.name]));
	const money = (minor: number) => moneyText(minor, currency);

	return lines.map((line, index) => {
		const net = line.amountMinor - (discounts[index] ?? 0);
		const exact =
			net === line.amountMinor &&
			(line.quantityMilli * line.unitPriceMinor) % 1000 === 0 &&
			(line.quantityMilli * line.unitPriceMinor) / 1000 === net;
		const taxType =
			[line.taxId, line.secondTaxId]
				.filter((id): id is string => id !== null)
				.map((id) => taxName.get(id) ?? "")
				.join(" + ") || options.noTaxType;
		const cells: Record<(typeof XERO_COLUMNS)[number], string> = {
			"*ContactName": invoice.clientName,
			EmailAddress: invoice.email ?? "",
			POAddressLine1: "",
			POAddressLine2: "",
			POAddressLine3: "",
			POAddressLine4: "",
			POCity: "",
			PORegion: "",
			POPostalCode: "",
			POCountry: "",
			"*InvoiceNumber": invoice.number,
			Reference: invoice.poNumber ?? "",
			"*InvoiceDate": xeroDate(invoice.issuedOn, options.dateOrder),
			"*DueDate": xeroDate(invoice.dueOn, options.dateOrder),
			InventoryItemCode: "",
			"*Description": line.description,
			"*Quantity": exact ? quantityText(line.quantityMilli) : "1",
			"*UnitAmount": money(exact ? line.unitPriceMinor : net),
			Discount: "",
			"*AccountCode": options.accountCode,
			"*TaxType": taxType,
			TrackingName1: "",
			TrackingOption1: "",
			TrackingName2: "",
			TrackingOption2: "",
			Currency: currency,
			BrandingTheme: "",
		};
		return XERO_COLUMNS.map((column) => cells[column]);
	});
}

/** The whole file: the headings, then each invoice's rows, each line ended by CRLF. */
export function xeroCsv(
	invoices: readonly XeroInvoice[],
	taxes: readonly Pick<TaxRow, "id" | "name">[],
	options: XeroOptions,
): string {
	let file = csvLine(XERO_COLUMNS);
	for (const invoice of invoices) {
		for (const row of xeroRows(invoice, taxes, options)) file += csvLine(row);
	}
	return file;
}

/** The file's name: "timesifier-acme-xero-2026-11-01-to-2026-11-30.csv". */
export function xeroFilename(slug: string, first: Day, last: Day): string {
	return `timesifier-${slug}-xero-${first}-to-${last}.csv`;
}
