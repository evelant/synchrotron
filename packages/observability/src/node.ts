import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as OtlpLogger from "@effect/opentelemetry/OtlpLogger"
import * as OtlpMetrics from "@effect/opentelemetry/OtlpMetrics"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Config, Duration, Effect, Layer, Logger } from "effect"

type AnnotationEntry = readonly [string, unknown]

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null) return false
	if (Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

const normalizeMessage = (message: unknown): ReadonlyArray<unknown> =>
	Array.isArray(message) ? message : [message]

const normalizeAnnotations = (annotations: unknown): ReadonlyArray<AnnotationEntry> => {
	if (Array.isArray(annotations)) return annotations as ReadonlyArray<AnnotationEntry>
	const iterator = (annotations as any)?.[Symbol.iterator]
	if (typeof iterator === "function") {
		try {
			return Array.from(annotations as Iterable<AnnotationEntry>)
		} catch {
			return []
		}
	}
	return []
}

const moveLogDataToAnnotations = (options: any): any => {
	const parts = normalizeMessage(options.message)
	if (parts.length !== 2 || typeof parts[0] !== "string" || !isPlainObject(parts[1])) {
		return options
	}

	const annotations = normalizeAnnotations(options.annotations)
	const existingKeys = new Set(annotations.map(([k]) => k))
	const dataEntries = Object.entries(parts[1]).filter(([k]) => existingKeys.has(k) === false)

	return {
		...options,
		message: parts[0],
		annotations: [...annotations, ...dataEntries]
	}
}

export interface OtelNodeSdkOptions {
	/**
	 * Used when `OTEL_SERVICE_NAME` is not set.
	 *
	 * This should be the consumer app's name (not `synchrotron`).
	 */
	readonly defaultServiceName: string
}

/**
 * Installs the Effect OpenTelemetry tracer using the OpenTelemetry Node SDK + OTLP/HTTP exporter.
 *
 * Defaults:
 * - Collector: `http://localhost:4318/v1/traces` (OpenTelemetry SDK default)
 * - Enable/disable: `OTEL_SDK_DISABLED=true` disables the layer
 * - Service name override: `OTEL_SERVICE_NAME`
 *
 * Collector endpoint overrides:
 * - `OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318` (base; SDK appends `/v1/traces`)
 * - or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host:4318/v1/traces` (full)
 */
export const makeOtelNodeSdkLayer = (options: OtelNodeSdkOptions) =>
	Layer.unwrapEffect(
		Effect.gen(function* () {
			const disabled = yield* Config.boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false))
			if (disabled) {
				return Layer.empty
			}

			const serviceName = yield* Config.string("OTEL_SERVICE_NAME").pipe(
				Config.withDefault(options.defaultServiceName)
			)

			return NodeSdk.layer(() => ({
				resource: { serviceName },
				spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter())
			}))
		})
	)

/**
 * Exports Effect logs to OTLP/HTTP, so they show up in Grafana Loki.
 *
 * Defaults:
 * - Enable/disable: `OTEL_LOGS_ENABLED=true` enables the layer
 * - Service name override: `OTEL_SERVICE_NAME`
 * - Collector logs endpoint: `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (default `http://localhost:4318/v1/logs`)
 *
 * Note: this does **not** replace console logging; it adds an additional sink.
 */
export const makeOtelNodeOtlpLoggerLayer = (options: OtelNodeSdkOptions) =>
	Layer.unwrapEffect(
		Effect.gen(function* () {
			const disabled = yield* Config.boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false))
			if (disabled) {
				return Layer.empty
			}

			const enabled = yield* Config.boolean("OTEL_LOGS_ENABLED").pipe(Config.withDefault(false))
			if (!enabled) {
				return Layer.empty
			}

			const serviceName = yield* Config.string("OTEL_SERVICE_NAME").pipe(
				Config.withDefault(options.defaultServiceName)
			)

			const url = yield* Config.string("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT").pipe(
				Config.withDefault("http://localhost:4318/v1/logs")
			)

			return Logger.addScoped(
				OtlpLogger.make({ url, resource: { serviceName } }).pipe(
					Effect.map((base) =>
						Logger.mapInputOptions(base, moveLogDataToAnnotations)
					)
				)
			).pipe(Layer.provide(FetchHttpClient.layer))
		})
	)

/**
 * Exports Effect metrics to OTLP/HTTP, so they show up in Prometheus / Grafana.
 *
 * Defaults:
 * - Enable/disable: `OTEL_METRICS_ENABLED=true` enables the layer
 * - Service name override: `OTEL_SERVICE_NAME`
 * - Collector metrics endpoint: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (default `http://localhost:4318/v1/metrics`)
 * - Export interval: `OTEL_METRICS_EXPORT_INTERVAL` (default `10 seconds`)
 */
export const makeOtelNodeOtlpMetricsLayer = (options: OtelNodeSdkOptions) =>
	Layer.unwrapEffect(
		Effect.gen(function* () {
			const disabled = yield* Config.boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false))
			if (disabled) {
				return Layer.empty
			}

			const enabled = yield* Config.boolean("OTEL_METRICS_ENABLED").pipe(Config.withDefault(false))
			if (!enabled) {
				return Layer.empty
			}

			const serviceName = yield* Config.string("OTEL_SERVICE_NAME").pipe(
				Config.withDefault(options.defaultServiceName)
			)

			const url = yield* Config.string("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT").pipe(
				Config.withDefault("http://localhost:4318/v1/metrics")
			)

			const exportInterval = yield* Config.duration("OTEL_METRICS_EXPORT_INTERVAL").pipe(
				Config.withDefault(Duration.seconds(10))
			)

			return OtlpMetrics.layer({ url, resource: { serviceName }, exportInterval }).pipe(
				Layer.provide(FetchHttpClient.layer)
			)
		})
	)
