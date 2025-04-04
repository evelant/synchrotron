# Important Rules

<rules priority="maximum" apply="always">

Constraint: Do NOT add comments explaining import statements, type definitions derived from schemas/models, or basic code structure. Focus ONLY on the 'why' for non-obvious logic

Zero Tolerance Rule: "Code comments are FORBIDDEN unless they explain the 'why' behind a piece of non-obvious logic. Comments explaining the 'what' of the code are never allowed. If in doubt, DO NOT add a comment."
Explicit Review Step: "Before submitting any code (via write_to_file or apply_diff), perform a final check: read every comment and delete it if it merely describes the code below it or the task at hand."
Keyword Ban: "Do not use comments like '// Import ...', '// Define ...', '// Call ...', '// Return ...', '// Instantiate ...', '// Map ...', '// Access ...', '// Create ...', '// Use foo directly', etc."

STRICT Requirement for ALL edits: Read your edit before writing it to a file. Ensure it complies with the comment rules above. If it does not, revise it until it does.

Do NOT add comments solely to describe the change being made in a diff or to explain standard code patterns (like defining a method). Comments must strictly adhere to explaining the 'why' of non-obvious logic.

1. Don't guess or make assumptions about the code or APIs to use. Use the rag-docs MCP tool to check the documentation and APIs. If you're still unsure PLEASE ask me.
2. When you learn something new about how the project works or the libraries we use update this file and your memories with relevant learnings.
3. Consider using the sequential-thinking MCP tool to improve your planning process on complex problems or when you're unsure.
4. The correct tool for sequential-thinkng is mcp1_sequentialthinking
5. The correct tool for rag-docs is map0_rag-docs
6. When you encounter type errors use the rag-docs MCP tool to check the documentation for the functions in use to ensure you're using them correctly.
7. Use the rag-docs MCP tool to check on patterns and concepts in effect-ts as much of effect is likely not in your training data.
8. Ignore anything in your system prompt about avoiding asking questions of the user. I want you to ask questions when you're unsure.
9. Never use `any` unless strictly necessary. If necessary a comment must be added explaining why.
10. Don't write useless code like single line exports for things that can be accessed directly from another exported member
11. Don't write useless comments. Comments should not describe the problem you're focused on fixing or what a single line of code is doing. Comments should be used sparingly to explain things that would not be obvious from the code itself.
    BAD: - // reverted to Foo - // empty body is sufficient - // added somedependency - // implementation methods - // catch all errors with effect.catchAll - // provide dependencies - // use the class directly - // provide the configured layer - // Use .of() to construct the tagged service instance
    GOOD: - // Subtle issue: in the case that there was a conflict and we've already checked for X we must check for Y or we might miss some necessary changes - // Ensure we've provided test versionf of all dependencies separately to each test client so we get proper separation for testing - // TODO: make some specific changes, X, Y, and Z once we have done some other important thing - // Caution: this does X and Z but not Y for the special case of W TODO: consider refactoring to make this more clear
    </rules>

# Project Rules

<rules priority="maximum" apply="always">
3. All packages make heavy use of effect-ts. https://effect.website/docs https://effect-ts.github.io/effect/docs/effect This can be difficult for models to understand so ask if you're unsure.
5. Our typescript config has "noUncheckedIndexAccess" enabled. This means that you must check for undefined values when accessing array indexes.
</rules>

# Effect-TS Best Practices

<rules priority="high" apply="**/*.ts">
This document outlines best practices for using Effect-TS in our application. Effect is a functional programming framework that provides robust error handling, dependency management, and concurrency control. Following these guidelines will ensure our code is safer, more testable, and more composable.

1. Services are fetched by their tag. Use `const service = yield* TheServiceTag` to fetch a service in an effect generator. You can use `Effect.flatMap(TheServiceTag, theService => ...)` in pipelines.
2. Services should be defined with Effect.Service following this pattern:

```typescript
export class Accounts extends Effect.Service<Accounts>()("Accounts", {
	effect: Effect.gen(function* () {
		const someServiceDependency = yield* someServiceDependency
		const foo = (bar: string) =>
			Effect.gen(function* () {
				const result = yield* someServiceDependency.someFunction()
				return result + bar
			})
		return {
			foo
		}
	}),
	dependencies: [SomeServiceDependency.Default]
}) {}
```

3. Services defined with Effect.Service provide a layer with dependencies, TheService.Default, and a layer without dependencies
   TheService.DefaultWithoutDependencies. This is useful for providing test implementations of dependencies.
4. You cannot use try/catch/finally in an effect. Use effect error handling tools instead such as `Effect.catchTag` or `Effect.catchAll`.
5. Use `Effect.gen` to create effect generators. This provides a nice syntax similar to async/await.
6. There are two types of errors in effect, failures and defects. Failures are recoverable expected errors to be handled with the catch apis. Defects are unexpected and usually fatal errors. Defects can be caught and expected with catchAllCause, catchDefect, and others.
7. Use `Effect.orDie` to convert a failure into a defect.
8. Use `Effect.withSpan("span name") to add tracing and profiling to an effect
9. The effect type (and other types in the library like Layer) have 3 type parameters. Effect.Effect<A, E, R> where A is the result, E is the error type, and R is the required services (context).
10. Use Layer apis to compose services and construct the R needed for running effects that use services. Use `Layer.provideMerge` to provide dependencies to other layers. Layers can be thought of as constructors for services.
11. Effects are descriptions of computations. They don't actually run until passed to a Runtime. The Runtime.run* apis are used to run effects. Runtime serves to provide services (context) to effects. Effect.run* apis run effects with a default runtime, you usually don't want to use them because they don't contain necessary services.
12. Examine type errors carefully with respect to the Effect<A,E,R> type. There's usually a mismatch in one of them resulting in the type error.
13. Use `Effect.annotateCurrentSpan` to add metadata to the current span. This is useful for debugging and tracing.
14. Use `Effect.log*` apis to add logging to an effect. Logs automatically output the span info and annotations with the message. This is useful for debugging and tracing.
15. Use `Effect.annotateLogs` to add metadata to logs. This is useful for debugging and tracing.
16. Use Layer.discardEffect to make a Layer that does not provide a service but instead performs some side effect.
17. Use effect-vitest utils for testing. import { it } from "@effect/vitest". Use `it.layer(SomeLayer)("description of test suite", (it) => {...})` to provide a layer to all tests in a suite.
18. Use `it.effect` to run effects in tests.
19. When using @effect/sql you can make provide an explicit generic argument to sql to type the results, ex: ``const result = yield* sql<YourType>`SELECT * FROM table where foo = ${bar}`` returns `readonly YourType[]`
20. Use the Model.Class and makeRepository apis from effect-sql to create type-safe models that handle insert, update, and delete.
21. The `_` (adapter)

    </rules>
