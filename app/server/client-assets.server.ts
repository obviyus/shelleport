export type ClientAsset = {
	cacheControl: string;
	publicPath: string;
	sourcePath: string;
};

export type ClientAssets = {
	entryScriptPath: string;
	files: ClientAsset[];
	stylePaths: string[];
};
