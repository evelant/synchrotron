import React from "react"
import ReactDOM from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"

import "@fontsource/alegreya-sans/latin.css"
import { Theme } from "@radix-ui/themes"
import "@radix-ui/themes/styles.css"
import Root from "./routes/root"
import "./style.css"

import Index from "./routes/index"

// 8. Define Router
const router = createBrowserRouter([
	{
		path: `/`,
		element: <Root />,
		// errorElement: <ErrorPage />,
		children: [
			{
				index: true,
				element: <Index />
			}
		]
	}
])

// 9. Render Application
const rootElement = document.getElementById("root")
if (!rootElement) {
	throw new Error("Root element not found")
}

ReactDOM.createRoot(rootElement).render(
	<React.StrictMode>
		<Theme appearance="dark" accentColor="violet" panelBackground="solid">
			<RouterProvider router={router} />
		</Theme>
	</React.StrictMode>
)
