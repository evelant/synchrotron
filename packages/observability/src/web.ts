import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as OtlpLogger from "@effect/opentelemetry/OtlpLogger"
import * as OtlpMetrics from "@effect/opentelemetry/OtlpMetrics"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as Resource from "@effect/opentelemetry/Resource"
import * as Tracer from "@effect/opentelemetry/Tracer"
import type * as Duration from "effect/Duration"
import { Effect, Layer } from "effect"

export interface OtelWebSdkOptions {
	/**
	 * Used when `serviceName` is not set.
	 *
	 * This should be the consumer app's name (not `synchrotron`).
	 */
	readonly defaultServiceName: string
	/**
	 * Override the OpenTelemetry `service.name`.
	 */
	readonly serviceName?: string
	/**
	 * Optional OTLP HTTP trace endpoint.
	 *
	 * If omitted, the OpenTelemetry SDK default is used (typically `http://localhost:4318/v1/traces`).
	 */
	readonly tracesEndpoint?: string
	/**
	 * Disable the layer (no-op).
	 */
	readonly enabled?: boolean
}

export interface OtelWebOtlpLoggerOptions {
	/**
	 * Used when `serviceName` is not set.
	 *
	 * This should be the consumer app's name (not `synchrotron`).
	 */
	readonly defaultServiceName: string
	/**
	 * Override the OpenTelemetry `service.name`.
	 */
	readonly serviceName?: string
	/**
	 * Optional OTLP HTTP logs endpoint.
	 *
	 * If omitted, defaults to `http://localhost:4318/v1/logs`.
	 */
	readonly logsEndpoint?: string
	/**
	 * Disable the layer (no-op).
	 */
	readonly enabled?: boolean
}

export interface OtelWebOtlpMetricsOptions {
	/**
	 * Used when `serviceName` is not set.
	 *
	 * This should be the consumer app's name (not `synchrotron`).
	 */
	readonly defaultServiceName: string
	/**
	 * Override the OpenTelemetry `service.name`.
	 */
	readonly serviceName?: string
	/**
	 * Optional OTLP HTTP metrics endpoint.
	 *
	 * If omitted, defaults to `http://localhost:4318/v1/metrics`.
	 */
	readonly metricsEndpoint?: string
	/**
	 * Optional export interval.
	 */
	readonly exportInterval?: Duration.DurationInput
	/**
	 * Disable the layer (no-op).
	 */
	readonly enabled?: boolean
}

/**
 * Installs the Effect OpenTelemetry tracer using the OpenTelemetry Web SDK + OTLP/HTTP exporter.
 *
 * Note: web/mobile environments often need explicit configuration for the collector endpoint.
 */
export const makeOtelWebSdkLayer = (options: OtelWebSdkOptions) => {
	if (options.enabled === false) {
		return Layer.empty
	}

	const exporter = new OTLPTraceExporter(
		typeof options.tracesEndpoint === "string" && options.tracesEndpoint.length > 0
			? { url: options.tracesEndpoint }
			: undefined
	)

	const ResourceLive = Resource.layer({
		serviceName: options.serviceName ?? options.defaultServiceName
	})

	const TracerProviderLive = Layer.scoped(
		Tracer.OtelTracerProvider,
		Effect.flatMap(Resource.Resource, (resource) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const provider = new BasicTracerProvider({
						resource,
						spanProcessors: [new BatchSpanProcessor(exporter)]
					})
					return provider
				}),
				(provider) =>
					Effect.ignoreLogged(Effect.promise(() => provider.forceFlush().then(() => provider.shutdown())))
			)
		)
	)

	const TracerLive = Layer.provide(Tracer.layer, TracerProviderLive)

	return TracerLive.pipe(Layer.provideMerge(ResourceLive))
}

/**
 * Exports Effect logs to OTLP/HTTP, so they show up in Grafana Loki.
 *
 * Note: this is independent of trace export; if you want logs to correlate with traces, ensure
 * tracing is installed and that logs occur inside spans.
 */
export const makeOtelWebOtlpLoggerLayer = (options: OtelWebOtlpLoggerOptions) => {
	if (options.enabled === false) {
		return Layer.empty
	}

	const url = options.logsEndpoint ?? "http://localhost:4318/v1/logs"

	const serviceName = options.serviceName ?? options.defaultServiceName

	return OtlpLogger.layer({ url, resource: { serviceName } }).pipe(Layer.provide(FetchHttpClient.layer))
}

/**
 * Exports Effect metrics to OTLP/HTTP, so they show up in Prometheus / Grafana.
 */
export const makeOtelWebOtlpMetricsLayer = (options: OtelWebOtlpMetricsOptions) => {
	if (options.enabled === false) {
		return Layer.empty
	}

	const url =
		typeof options.metricsEndpoint === "string" && options.metricsEndpoint.length > 0
			? options.metricsEndpoint
			: "http://localhost:4318/v1/metrics"

	const serviceName = options.serviceName ?? options.defaultServiceName

	return OtlpMetrics.layer({
		url,
		resource: { serviceName },
		exportInterval: options.exportInterval
	}).pipe(Layer.provide(FetchHttpClient.layer))
}
