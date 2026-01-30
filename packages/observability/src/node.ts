import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as OtlpLogger from "@effect/opentelemetry/OtlpLogger"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Config, Effect, Layer } from "effect"

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

			return OtlpLogger.layer({ url, resource: { serviceName } }).pipe(
				Layer.provide(FetchHttpClient.layer)
			)
		})
	)
