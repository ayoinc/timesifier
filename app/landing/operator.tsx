/**
 * The company that runs this deployment (TS-121): the one a person who uses it
 * deals with, and the one that answers for what it stores. A company's website
 * must show its registered name, its number, where it is registered and its
 * registered office, so the foot of every public page says all four, and the
 * terms and the privacy notice say them again.
 *
 * No company is written in the code: a fork that is deployed is run by
 * somebody else. A deployment names its own in four settings
 * (docs/security.md, "Secrets"), and a page that would name the company is not
 * served while one of them is missing.
 */
import { required, type Settings } from "~/lib/deployment";

export interface Operator {
	/** The registered name, as the register has it. */
	name: string;
	/** The number the company is registered under. */
	companyNumber: string;
	/** Where it is registered: "England and Wales". */
	registeredIn: string;
	/** The address of its registered office, on one line. */
	registeredOffice: string;
}

/** The company this deployment names. Throws where it names none, or only part of one. */
export function deploymentOperator(env: Settings): Operator {
	return {
		name: required(env, "OPERATOR_NAME"),
		companyNumber: required(env, "OPERATOR_COMPANY_NUMBER"),
		registeredIn: required(env, "OPERATOR_REGISTERED_IN"),
		registeredOffice: required(env, "OPERATOR_REGISTERED_OFFICE"),
	};
}

/** Who runs Timesifier, in the same two sentences wherever a page says it. */
export function OperatorDetails({ operator }: { operator: Operator }) {
	return (
		<>
			Timesifier is operated by {operator.name}, a company registered in {operator.registeredIn}{" "}
			with company number {operator.companyNumber}. Its registered office is{" "}
			{operator.registeredOffice}.
		</>
	);
}
