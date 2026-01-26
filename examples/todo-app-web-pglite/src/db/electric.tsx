import { type LiveQuery, type LiveQueryResults } from "@electric-sql/pglite/live"
import { PgLiteSyncTag } from "@synchrotron/sync-client"
import { useService } from "../runtime"
import { useEffect, useState } from "react"
import { Todo } from "./schema"

export function useReactiveTodos() {
	const [todos, setTodos] = useState<readonly Todo[]>([])
	const [isLoading, setIsLoading] = useState(true)
	const db = useService(PgLiteSyncTag)

	useEffect(() => {
		if (!db) return

		let cancelled = false
		let liveQuery: LiveQuery<Todo> | undefined

		setIsLoading(true)

		db.extensions.live
			.query<Todo>("select * from todos order by text")
			.then((query) => {
				liveQuery = query
				if (cancelled) {
					void query.unsubscribe().catch(() => {})
					return
				}

				const handleResults = (results: LiveQueryResults<Todo>) => {
					if (cancelled) return
					setTodos(results.rows)
					setIsLoading(false)
				}

				handleResults(query.initialResults)
				query.subscribe(handleResults)
			})
			.catch((error) => {
				if (cancelled) return
				console.error("Error setting up live query for todos", error)
				setIsLoading(false)
			})

		return () => {
			cancelled = true
			if (liveQuery) {
				void liveQuery.unsubscribe().catch(() => {})
			}
		}
	}, [db])

	return {
		todos,
		isLoading
	}
}
