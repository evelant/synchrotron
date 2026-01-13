import type { ConfigContext, ExpoConfig } from "expo/config"
export default ({ config }: ConfigContext): ExpoConfig => ({
	name: "todo-app-react-native-sqlite",
	slug: "todo-app-react-native-sqlite",
	version: "1.0.0",
	orientation: "portrait",
	icon: "./assets/icon.png",
	userInterfaceStyle: "light",
	newArchEnabled: true,
	splash: {
		image: "./assets/splash-icon.png",
		resizeMode: "contain",
		backgroundColor: "#ffffff"
	},
	plugins: [
		[
			"expo-build-properties",
			{
				android: {
					minSdkVersion: 29,
					targetSdkVersion: 36,
					compileSdkVersion: 36
				}
			}
		]
	],
	ios: {
		supportsTablet: true
	},
	android: {
		adaptiveIcon: {
			foregroundImage: "./assets/adaptive-icon.png",
			backgroundColor: "#ffffff"
		},
		edgeToEdgeEnabled: true,
		predictiveBackGestureEnabled: false,
		package: "com.evelant.todoappreactnativesqlite"
	},
	web: {
		favicon: "./assets/favicon.png"
	}
})
