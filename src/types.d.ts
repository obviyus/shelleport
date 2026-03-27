declare module "*.css";
declare module "*.html" {
	const bundle: HTMLBundle;
	export default bundle;
}
