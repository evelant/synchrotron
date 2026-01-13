// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config")

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname, {
	annotateReactComponents: true,
	resolver: {
		// resolverMainFields: ["react-native", "browser", "main"],
		unstable_enableSymlinks: true,
		unstable_enablePackageExports: true,
		useWatchman: false
	}
})
config.transformer.getTransformOptions = async () => ({
	transform: {
		experimentalImportSupport: true
	}
})
module.exports = config
