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
import { Clock, Effect } from "effect"
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react"
import { TodoActions } from "../actions"
import logo from "../assets/logo.svg"
import { TodoRepo } from "../db/repositories"
import type { Todo } from "../db/schema"
import { useRuntime } from "../main"

export default function Index() {
	const runtime = useRuntime()
	const [todos, setTodos] = useState<readonly Todo[]>([])
	const [newTodoText, setNewTodoText] = useState("")

	const loadTodos = useCallback(() => {
		// Define the effect directly inside the callback
		const fetchTodosEffect = Effect.gen(function* () {
			const repo = yield* TodoRepo
			yield* Effect.logInfo(`loading todos`)
			// Use findAll() as defined in the repository
			return yield* repo.findAll()
		})

		runtime
			.runPromise(fetchTodosEffect) // Pass the locally defined effect
			.then((fetchedTodos: readonly Todo[]) => {
				setTodos(fetchedTodos)
			})
			.catch((err: Error) => console.error("Failed to fetch todos:", err))
	}, [runtime]) // Remove fetchTodosEffect from dependencies as it's defined inside

	// Initial load
	useEffect(() => {
		loadTodos()
	}, [loadTodos])

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
			})

			runtime
				.runPromise(createEffect)
				.then(() => {
					setNewTodoText("")
					loadTodos()
				})
				.catch((err: ActionExecutionError | Error) =>
					console.error("Failed to create todo:", JSON.stringify(err))
				)
		},
		[runtime, newTodoText, loadTodos]
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
			})

			runtime
				.runPromise(toggleEffect)
				.then(() => {
					loadTodos()
				})
				.catch((err: ActionExecutionError | Error) => console.error("Failed to toggle todo:", err))
		},
		[runtime, loadTodos]
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
			})

			runtime
				.runPromise(deleteEffect)
				.then(() => {
					loadTodos()
				})
				.catch((err: ActionExecutionError | Error) => console.error("Failed to delete todo:", err))
		},
		[runtime, loadTodos]
	)

	return (
		<Container size="1">
			<Flex gap="5" mt="5" direction="column">
				<Flex align="center" justify="center">
					<img src={logo} width="32px" alt="logo" />
					<Heading ml="1">Synchrotron To-Dos</Heading>
					<Box width="32px" />
				</Flex>

				<Flex gap="3" direction="column">
					{todos.length === 0 ? (
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
	)
}
