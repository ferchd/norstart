declare module "*.toml" {
	const configuration: { readonly sql: unknown };
	export default configuration;
}
