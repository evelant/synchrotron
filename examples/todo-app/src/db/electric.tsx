import { type LiveQueryResults } from "@electric-sql/pglite/live"
import { PgLiteSyncTag } from "@synchrotron/sync-client/index"
import { useRuntime, useService } from "examples/todo-app/src/main"
import { useEffect, useState } from "react"
import { Todo } from "./schema"

export function useReactiveTodos() {
	const [todos, setTodos] = useState<readonly Todo[]>([])
	const [isLoading, setIsLoading] = useState(true)
	const db = useService(PgLiteSyncTag)
	const runtime = useRuntime()
	console.log(`useReactiveTodos`, db, runtime)
	useEffect(() => {
		try {
			if (db) {
				const loadTodos = () => {
					console.log(`loadTodos starting live query`)
					db.extensions.live.query<Todo>("select * from todos").then((todos) => {
						try {
							setTodos(todos.initialResults.rows)
							const callback = (newTodos: LiveQueryResults<Todo>) => {
								console.log(`live query todos got new rows`, newTodos.rows)
								setTodos(newTodos.rows)
							}
							todos.subscribe(callback)
							return () => todos.unsubscribe(callback)
						} catch (e) {
							console.error(`Error setting up live query for todos`, e)
						}
					})
				}

				// Initial load
				const unsub = loadTodos()

				return unsub
			} else {
				console.warn("Electric SQL not available")
				setIsLoading(false)
			}
		} catch (e) {
			console.error("Error setting up Electric SQL subscription:", e)
			setIsLoading(false)
		}

		return undefined
	}, [db, runtime])

	return {
		todos,
		isLoading
	}
}
