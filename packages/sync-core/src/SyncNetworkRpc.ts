import { Rpc, RpcGroup, RpcMiddleware } from "@effect/rpc"
import { Schema } from "effect"
import { HLC } from "./HLC"
import { ActionModifiedRow, ActionRecord } from "./models"
import {
	FetchRemoteActionsFailureSchema,
	RemoteActionFetchError,
	SendLocalActionsFailureSchema
} from "./SyncNetworkService"

const FetchResultSchema = Schema.Struct({
	serverEpoch: Schema.String,
	minRetainedServerIngestId: Schema.Number,
	actions: Schema.Array(ActionRecord.json),
	modifiedRows: Schema.Array(ActionModifiedRow.json)
})

const SnapshotTableSchema = Schema.Struct({
	tableName: Schema.String,
	rows: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
})

const BootstrapSnapshotSchema = Schema.Struct({
	serverEpoch: Schema.String,
	minRetainedServerIngestId: Schema.Number,
	serverIngestId: Schema.Number,
	serverClock: HLC,
	tables: Schema.Array(SnapshotTableSchema)
})

/**
 * Client-side middleware hook for attaching authentication (e.g. Authorization header) to RPC requests.
 *
 * Server auth is still enforced by `packages/sync-server` and RLS; this middleware is purely a
 * transport convenience so clients can supply a dynamic token per request (refresh without restart).
 */
export class SyncRpcAuthMiddleware extends RpcMiddleware.Tag<SyncRpcAuthMiddleware>()(
	"SyncRpcAuthMiddleware",
	{
		requiredForClient: true
	}
) {}

export class FetchRemoteActions extends Schema.TaggedRequest<FetchRemoteActions>()(
	"FetchRemoteActions",
	{
		payload: {
			clientId: Schema.String,
			sinceServerIngestId: Schema.Number,
			/**
			 * When true, include actions authored by `clientId` in the response.
			 *
			 * This is primarily used for bootstrap / local DB restore when the client has lost its local
			 * action log but retained its identity, and needs to re-ingest its own canonical history.
			 */
			includeSelf: Schema.optional(Schema.Boolean)
		},
		success: FetchResultSchema,
		failure: FetchRemoteActionsFailureSchema
	}
) {}

export class FetchBootstrapSnapshot extends Schema.TaggedRequest<FetchBootstrapSnapshot>()(
	"FetchBootstrapSnapshot",
	{
		payload: {
			clientId: Schema.String
		},
		success: BootstrapSnapshotSchema,
		failure: RemoteActionFetchError
	}
) {}

export class SendLocalActions extends Schema.TaggedRequest<SendLocalActions>()("SendLocalActions", {
	payload: {
		clientId: Schema.String,
		basisServerIngestId: Schema.Number,
		actions: Schema.Array(ActionRecord.json),
		amrs: Schema.Array(ActionModifiedRow.json)
	},
	success: Schema.Boolean,
	failure: SendLocalActionsFailureSchema
}) {}

export class SyncNetworkRpcGroup extends RpcGroup.make(
	Rpc.fromTaggedRequest(FetchRemoteActions),
	Rpc.fromTaggedRequest(FetchBootstrapSnapshot),
	Rpc.fromTaggedRequest(SendLocalActions)
).middleware(SyncRpcAuthMiddleware) {}
