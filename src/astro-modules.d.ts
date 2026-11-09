declare module "*.astro" {
	const Component: (props: Record<string, unknown>) => unknown;
	export default Component;
}

declare module "cloudflare:workers" {
	export const env: unknown;
}
