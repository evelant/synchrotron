import { StatusBar } from "expo-status-bar"
import { Clock, Effect } from "effect"
import React, { useCallback, useEffect, useRef, useState } from "react"
import {
	ActivityIndicator,
	Alert,
	DevSettings,
	FlatList,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View
} from "react-native"
import { type ActionExecutionError, SyncService } from "@synchrotron/sync-core"
import { KeyValueStore } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { TodoActions } from "./src/actions"
import type { Todo } from "./src/db/schema"
import { TodoRepo } from "./src/db/repositories"
import { setupClientDatabase } from "./src/db/setup"
import { RuntimeProvider, sqliteFilename, useRuntime } from "./src/runtime"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"

function AppInner() {
	const runtime = useRuntime()

	const [todos, setTodos] = useState<readonly Todo[]>([])
	const [isLoading, setIsLoading] = useState(true)
	const [isSyncing, setIsSyncing] = useState(false)
	const [isResetting, setIsResetting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [newTodoText, setNewTodoText] = useState("")
	const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
	const syncingRef = useRef(false)
	const resettingRef = useRef(false)

	const resetDatabaseEffect = useCallback(
		(options: { readonly resetIdentity: boolean }) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("todoApp.reset.start", {
					platform: Platform.OS,
					sqliteFilename,
					resetIdentity: options.resetIdentity
				})
				const sql = yield* SqlClient.SqlClient

				yield* Effect.gen(function* () {
					yield* sql`DROP TABLE IF EXISTS action_modified_rows`.raw
					yield* sql`DROP TABLE IF EXISTS action_records`.raw
					yield* sql`DROP TABLE IF EXISTS client_sync_status`.raw
					yield* sql`DROP TABLE IF EXISTS local_applied_action_ids`.raw
					yield* sql`DROP TABLE IF EXISTS todos`.raw
				}).pipe(sql.withTransaction)

				if (options.resetIdentity) {
					const kv = yield* KeyValueStore.KeyValueStore
					yield* kv.remove("sync_client_id")
					yield* Effect.logInfo("todoApp.reset.identityCleared")
				}

				if (!options.resetIdentity) {
					yield* Effect.logInfo("todoApp.reset.schemaReinit.start")
					// The runtime layer includes `setupClientDatabase`, but we call it again here to ensure
					// the DB is immediately usable without requiring an app reload.
					yield* setupClientDatabase
					yield* Effect.logInfo("todoApp.reset.schemaReinit.done")
				}

				yield* Effect.logInfo("todoApp.reset.done")
			}).pipe(Effect.withSpan("todoApp.reset")),
		[]
	)

	const loadTodos = useCallback(() => {
		const effect = Effect.gen(function* () {
			const todoRepo = yield* TodoRepo
			return yield* todoRepo.findAll()
		})

		return runtime
			.runPromise(effect)
			.then((rows) => setTodos(rows))
			.catch((e) => {
				console.error("Failed to load todos", e)
				setError(String(e))
			})
	}, [runtime])

	const syncOnce = useCallback(() => {
		if (resettingRef.current) return Promise.resolve()
		if (syncingRef.current) return Promise.resolve()
		syncingRef.current = true
		setIsSyncing(true)

		const effect = Effect.gen(function* () {
			const syncService = yield* SyncService
			yield* syncService.performSync()
		})

		return runtime
			.runPromise(effect)
			.catch((e) => console.warn("Sync failed", e))
			.finally(() => {
				syncingRef.current = false
				setIsSyncing(false)
			})
			.then(() => loadTodos())
	}, [runtime, loadTodos])

	const stopSyncInterval = useCallback(() => {
		if (syncIntervalRef.current) {
			clearInterval(syncIntervalRef.current)
			syncIntervalRef.current = null
		}
	}, [])

	const startSyncInterval = useCallback(() => {
		stopSyncInterval()
		syncIntervalRef.current = setInterval(() => {
			void syncOnce()
		}, 4000)
	}, [stopSyncInterval, syncOnce])

	useEffect(() => {
		let cancelled = false

		const boot = async () => {
			setIsLoading(true)
			setError(null)

			try {
				await loadTodos()
				await syncOnce()

				if (!cancelled) {
					startSyncInterval()
				}
			} finally {
				if (!cancelled) setIsLoading(false)
			}
		}

		void boot()

		return () => {
			cancelled = true
			stopSyncInterval()
		}
	}, [loadTodos, syncOnce, startSyncInterval, stopSyncInterval])

	const runReset = useCallback(
		(options: { readonly resetIdentity: boolean }) => {
			if (isResetting) return
			resettingRef.current = true
			setIsResetting(true)
			setError(null)
			stopSyncInterval()

			runtime
				.runPromise(resetDatabaseEffect(options))
				.then(() => {
					if (options.resetIdentity) {
						if (Platform.OS === "web") {
							window.location.reload()
							return
						}
						if (typeof DevSettings.reload === "function") {
							DevSettings.reload()
							return
						}
						Alert.alert("Reload required", "Please restart the app to finish resetting the identity.")
						return
					}

					return loadTodos()
						.then(() => syncOnce())
						.then(() => startSyncInterval())
				})
				.catch((e) => {
					console.error("Reset failed", e)
					setError(String(e))
				})
				.finally(() => {
					resettingRef.current = false
					setIsResetting(false)
				})
		},
		[
			isResetting,
			loadTodos,
			resetDatabaseEffect,
			runtime,
			startSyncInterval,
			stopSyncInterval,
			syncOnce
		]
	)

	const resetLocalDb = useCallback(() => {
		Alert.alert("Reset local database?", "This clears all local data for this app.", [
			{ text: "Cancel", style: "cancel" },
			{ text: "Reset", style: "destructive", onPress: () => runReset({ resetIdentity: false }) }
		])
	}, [runReset])

	const resetIdentity = useCallback(() => {
		Alert.alert(
			"Reset identity?",
			"This clears the persisted client id and resets the local database. The app will reload.",
			[
				{ text: "Cancel", style: "cancel" },
				{ text: "Reset", style: "destructive", onPress: () => runReset({ resetIdentity: true }) }
			]
		)
	}, [runReset])

	const handleAddTodo = useCallback(() => {
		const text = newTodoText.trim()
		if (!text) return

		setError(null)

		const createEffect = Effect.gen(function* () {
			const syncService = yield* SyncService
			const actions = yield* TodoActions
			const timestamp = yield* Clock.currentTimeMillis

			const action = actions.createTodoAction({
				text,
				owner_id: "user1",
				timestamp
			})

			yield* syncService.executeAction(action)
			yield* syncService.performSync()
		})

		runtime
			.runPromise(createEffect)
			.then(() => setNewTodoText(""))
			.then(() => loadTodos())
			.catch((err: ActionExecutionError | Error) => {
				console.error("Failed to create todo:", err)
				setError(String(err))
				return loadTodos()
			})
	}, [runtime, newTodoText, loadTodos])

	const handleToggleTodo = useCallback(
		(todo: Todo) => {
			setError(null)

			const toggleEffect = Effect.gen(function* () {
				const syncService = yield* SyncService
				const actions = yield* TodoActions
				const timestamp = yield* Clock.currentTimeMillis

				const action = actions.toggleTodoCompletionAction({
					id: todo.id,
					timestamp
				})

				yield* syncService.executeAction(action)
				yield* syncService.performSync()
			})

			runtime
				.runPromise(toggleEffect)
				.then(() => loadTodos())
				.catch((err: ActionExecutionError | Error) => {
					console.error("Failed to toggle todo:", err)
					setError(String(err))
					return loadTodos()
				})
		},
		[runtime, loadTodos]
	)

	const handleDeleteTodo = useCallback(
		(todoId: string) => {
			setError(null)

			const deleteEffect = Effect.gen(function* () {
				const syncService = yield* SyncService
				const actions = yield* TodoActions
				const timestamp = yield* Clock.currentTimeMillis

				const action = actions.deleteTodoAction({
					id: todoId,
					timestamp
				})

				yield* syncService.executeAction(action)
				yield* syncService.performSync()
			})

			runtime
				.runPromise(deleteEffect)
				.then(() => loadTodos())
				.catch((err: ActionExecutionError | Error) => {
					console.error("Failed to delete todo:", err)
					setError(String(err))
					return loadTodos()
				})
		},
		[runtime, loadTodos]
	)

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<View style={styles.header}>
				<View style={styles.headerTopRow}>
					<Text style={styles.title}>Synchrotron To-Dos</Text>
					<View style={styles.headerButtons}>
						<Pressable
							style={[styles.resetButton, isResetting ? styles.resetButtonDisabled : null]}
							onPress={resetLocalDb}
							disabled={isResetting}
							accessibilityRole="button"
							accessibilityLabel="Reset local database"
						>
							<Text style={styles.resetButtonText}>{isResetting ? "Resetting…" : "Reset DB"}</Text>
						</Pressable>
						<Pressable
							style={[styles.resetButton, isResetting ? styles.resetButtonDisabled : null]}
							onPress={resetIdentity}
							disabled={isResetting}
							accessibilityRole="button"
							accessibilityLabel="Reset identity"
						>
							<Text style={styles.resetButtonText}>Reset ID</Text>
						</Pressable>
					</View>
				</View>
				<Text style={styles.subtitle}>{isResetting ? "Resetting…" : isSyncing ? "Syncing…" : " "}</Text>
			</View>

			{error ? <Text style={styles.error}>{error}</Text> : null}

			<View style={styles.content}>
				{isLoading ? (
					<View style={styles.centered}>
						<ActivityIndicator />
						<Text style={styles.muted}>Loading todos…</Text>
					</View>
				) : todos.length === 0 ? (
					<View style={styles.centered}>
						<Text style={styles.muted}>No to-dos to show - add one!</Text>
					</View>
				) : (
					<FlatList
						data={todos as Todo[]}
						keyExtractor={(todo) => todo.id}
						contentContainerStyle={styles.list}
						renderItem={({ item }) => (
							<Pressable
								style={styles.todoRow}
								onPress={() => handleToggleTodo(item)}
								accessibilityRole="button"
							>
								<View style={[styles.checkbox, item.completed ? styles.checkboxChecked : null]} />
								<Text style={[styles.todoText, item.completed ? styles.todoTextCompleted : null]}>
									{item.text}
								</Text>
								<Pressable
									style={styles.deleteButton}
									hitSlop={10}
									onPress={(e) => {
										e.stopPropagation()
										handleDeleteTodo(item.id)
									}}
									accessibilityRole="button"
									accessibilityLabel={`Delete todo: ${item.text}`}
								>
									<Text style={styles.deleteText}>X</Text>
								</Pressable>
							</Pressable>
						)}
					/>
				)}
			</View>

			<View style={styles.inputRow}>
				<TextInput
					style={styles.input}
					value={newTodoText}
					onChangeText={setNewTodoText}
					placeholder="New Todo"
					placeholderTextColor="#666"
					autoCapitalize="sentences"
					returnKeyType="done"
					onSubmitEditing={handleAddTodo}
				/>
				<Pressable
					style={[
						styles.addButton,
						newTodoText.trim().length === 0 ? styles.addButtonDisabled : null
					]}
					onPress={handleAddTodo}
					disabled={newTodoText.trim().length === 0}
					accessibilityRole="button"
				>
					<Text style={styles.addButtonText}>Add</Text>
				</Pressable>
			</View>
		</SafeAreaView>
	)
}

export default function App() {
	return (
		<SafeAreaProvider>
			<RuntimeProvider>
				<AppInner />
			</RuntimeProvider>
		</SafeAreaProvider>
	)
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#0c0d10",
		paddingHorizontal: 16,
		paddingVertical: 12
	},
	header: {
		gap: 4,
		marginBottom: 12
	},
	headerTopRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12
	},
	headerButtons: {
		flexDirection: "row",
		gap: 8
	},
	title: {
		color: "white",
		fontSize: 28,
		fontWeight: "700"
	},
	resetButton: {
		borderRadius: 10,
		paddingHorizontal: 10,
		paddingVertical: 8,
		backgroundColor: "#151821"
	},
	resetButtonDisabled: {
		opacity: 0.4
	},
	resetButtonText: {
		color: "#9aa0a6",
		fontSize: 12,
		fontWeight: "700"
	},
	subtitle: {
		color: "#9aa0a6",
		fontSize: 12
	},
	error: {
		color: "#ff6b6b",
		marginBottom: 8
	},
	content: {
		flex: 1
	},
	centered: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		gap: 12
	},
	muted: {
		color: "#9aa0a6"
	},
	list: {
		gap: 10,
		paddingBottom: 12
	},
	todoRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingVertical: 12,
		paddingHorizontal: 12,
		borderRadius: 12,
		backgroundColor: "#151821"
	},
	checkbox: {
		width: 18,
		height: 18,
		borderRadius: 5,
		borderWidth: 1,
		borderColor: "#6b7280"
	},
	checkboxChecked: {
		backgroundColor: "#8b5cf6",
		borderColor: "#8b5cf6"
	},
	todoText: {
		flex: 1,
		color: "white",
		fontSize: 16
	},
	todoTextCompleted: {
		color: "#9aa0a6",
		textDecorationLine: "line-through"
	},
	deleteButton: {
		paddingHorizontal: 8,
		paddingVertical: 6
	},
	deleteText: {
		color: "#9aa0a6",
		fontSize: 16,
		fontWeight: "700"
	},
	inputRow: {
		flexDirection: "row",
		gap: 10
	},
	input: {
		flex: 1,
		borderRadius: 12,
		paddingHorizontal: 12,
		paddingVertical: 12,
		backgroundColor: "#151821",
		color: "white"
	},
	addButton: {
		borderRadius: 12,
		paddingHorizontal: 14,
		paddingVertical: 12,
		backgroundColor: "#8b5cf6",
		justifyContent: "center"
	},
	addButtonDisabled: {
		opacity: 0.4
	},
	addButtonText: {
		color: "white",
		fontWeight: "700"
	}
})
