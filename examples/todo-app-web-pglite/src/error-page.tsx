import { useRouteError } from "react-router"

export default function ErrorPage() {
	const error = useRouteError() as Error & { statusText?: string }
	console.error(error)

	return (
		<div id="error-page">
			<h1>Oops!</h1>
			<p>Sorry, an unexpected error has occurred.</p>
			<p>
				<i>{JSON.stringify(error)}</i>
				<i>{error.statusText ?? error.message}</i>
			</p>
		</div>
	)
}
