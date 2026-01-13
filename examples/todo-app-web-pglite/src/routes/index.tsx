import { PgliteClient } from "@effect/sql-pglite"
import { Repl } from "@electric-sql/pglite-repl"
import {
	Box,
	Button,
	Card,
	Checkbox,
	Container,
	Flex,
	Heading,
	Text,
	TextField
} from "@radix-ui/themes"
import { SyncService, type ActionExecutionError } from "@synchrotron/sync-core"
import { useReactiveTodos } from "@synchrotron/todo-app-web-pglite/db/electric"
import { Clock, Effect } from "effect"
import React, { useCallback, useState, type ChangeEvent, type FormEvent } from "react"
import { TodoActions } from "../actions"
import logo from "../assets/logo.svg"
import type { Todo } from "../db/schema"
import { useRuntime, useService } from "../main"

export default function Index() {
	const runtime = useRuntime()
	const [newTodoText, setNewTodoText] = useState("")

	const { todos, isLoading } = useReactiveTodos()

	const handleAddTodo = useCallback(
		(event: FormEvent<HTMLFormElement>) => {
			event.preventDefault()
			const text = newTodoText.trim()
			if (!text) return

			const createEffect = Effect.gen(function* () {
				const syncService = yield* SyncService
				const actions = yield* TodoActions
				const timestamp = yield* Clock.currentTimeMillis

				const action = actions.createTodoAction({
					text: text,
					owner_id: "user1", // Placeholder
					timestamp: timestamp
				})
				yield* syncService.executeAction(action)
				yield* syncService.performSync()
			})

			runtime
				.runPromise(createEffect)
				.then(() => setNewTodoText(""))
				.catch((err: ActionExecutionError | Error) =>
					console.error("Failed to create todo:", JSON.stringify(err))
				)
		},
		[runtime, newTodoText]
	)

	const handleToggleTodo = useCallback(
		(todo: Todo) => {
			const toggleEffect = Effect.gen(function* () {
				const syncService = yield* SyncService
				const actions = yield* TodoActions
				const timestamp = yield* Clock.currentTimeMillis

				const action = actions.toggleTodoCompletionAction({
					id: todo.id,
					timestamp: timestamp
				})
				yield* syncService.executeAction(action)
				yield* syncService.performSync()
			})

			runtime
				.runPromise(toggleEffect)
				.then(() => {})
				.catch((err: ActionExecutionError | Error) => console.error("Failed to toggle todo:", err))
		},
		[runtime]
	)

	const handleDeleteTodo = useCallback(
		(todoId: string) => {
			const deleteEffect = Effect.gen(function* () {
				const syncService = yield* SyncService
				const actions = yield* TodoActions
				const timestamp = yield* Clock.currentTimeMillis

				const action = actions.deleteTodoAction({
					id: todoId,
					timestamp: timestamp
				})
				yield* syncService.executeAction(action)
				yield* syncService.performSync()
			})

			runtime
				.runPromise(deleteEffect)

				.catch((err: ActionExecutionError | Error) => console.error("Failed to delete todo:", err))
		},
		[runtime]
	)

	return (
		<>
			<Container size="2">
				<Flex gap="5" mt="5" direction="column">
					<Flex align="center" justify="center">
						<img src={logo} width="32px" alt="logo" />
						<Heading ml="1">Synchrotron To-Dos</Heading>
						<Box width="32px" />
					</Flex>

					<Flex gap="3" direction="column">
						{isLoading ? (
							<Flex justify="center">
								<Text>Loading todos...</Text>
							</Flex>
						) : todos.length === 0 ? (
							<Flex justify="center">
								<Text>No to-dos to show - add one!</Text>
							</Flex>
						) : (
							todos.map((todo: Todo) => (
								<Card key={todo.id} onClick={() => handleToggleTodo(todo)}>
									<Flex gap="2" align="center" justify="between">
										<Text as="label">
											<Flex gap="2" align="center">
												<Checkbox checked={!!todo.completed} />
												{todo.text}
											</Flex>
										</Text>
										<Button
											onClick={(e) => {
												e.stopPropagation()
												handleDeleteTodo(todo.id)
											}}
											variant="ghost"
											ml="auto"
											style={{ cursor: `pointer` }}
										>
											X
										</Button>
									</Flex>
								</Card>
							))
						)}
					</Flex>
					<form style={{ width: `100%` }} onSubmit={handleAddTodo}>
						<Flex direction="row">
							<TextField.Root
								value={newTodoText}
								onChange={(e: ChangeEvent<HTMLInputElement>) => setNewTodoText(e.target.value)}
								type="text"
								name="todo"
								placeholder="New Todo"
								mr="1"
								style={{ width: `100%` }}
							/>
							<Button type="submit" disabled={!newTodoText.trim()}>
								Add
							</Button>
						</Flex>
					</form>
				</Flex>
			</Container>
			<Container size="4" mt="5">
				<DebugRepl />
			</Container>
		</>
	)
}

const DebugRepl = React.memo(() => {
	const pglite = useService(PgliteClient.PgliteClient)
	if (!pglite) return <p>Loading repl...</p>
	return (
		<>
			<h2>PGlite Repl</h2>
			<Repl pg={pglite.pg} border={true} theme={"dark"} />
		</>
	)
})
