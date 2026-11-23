import openapi from "../../docs/openapi.yaml?raw";

// The API's description for tools (TS-106): docs/openapi.yaml as it is in the
// repository, to anyone, without a token. Every other address under /api/v1
// asks for one (routes/api.v1.$.ts). test/integrations/api.test.ts holds the
// description to the API's routes.

export function loader() {
	return new Response(openapi, {
		headers: {
			"Content-Type": "application/yaml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
