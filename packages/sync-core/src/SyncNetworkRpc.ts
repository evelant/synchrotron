import { Rpc, RpcGroup } from "@effect/rpc" // Import Rpc and RpcGroup
import { Schema } from "effect"
import { HLC } from "./HLC"
import { ActionModifiedRow, ActionRecord } from "./models" // Import Model classes directly
// Import error/result types for clarity, though not strictly needed for schema def
import { type NetworkRequestError as NetworkRequestErrorType, type RemoteActionFetchError as RemoteActionFetchErrorType, type FetchResult as FetchResultType, RemoteActionFetchError, NetworkRequestError } from "./SyncNetworkService"



// Define Schema for FetchResult - Use the imported Model Classes directly
const FetchResultSchema = Schema.Struct({
	actions: Schema.Array(ActionRecord), // Use class directly
	modifiedRows: Schema.Array(ActionModifiedRow) // Use class directly
})

// --- Define RPC Request Schemas using class pattern ---

export class FetchRemoteActions extends Schema.TaggedRequest<FetchRemoteActions>()(
	"FetchRemoteActions",
	{
		// Provide payload fields directly
		payload: {
			clientId: Schema.String,
			lastSyncedClock: HLC
		},
		success: FetchResultSchema,
		failure: RemoteActionFetchError
	}
) {} // Empty class body is sufficient

export class SendLocalActions extends Schema.TaggedRequest<SendLocalActions>()(
	"SendLocalActions",
	{
		// Provide payload fields directly
		payload: {
			clientId: Schema.String,
			actions: Schema.Array(ActionRecord), // Use class directly
			amrs: Schema.Array(ActionModifiedRow) // Use class directly
		},
		success: Schema.Boolean,
		failure: NetworkRequestError
	}
) {} // Empty class body is sufficient

// Define the RpcGroup using the request schemas
export class SyncNetworkRpcGroup extends RpcGroup.make(
	Rpc.fromTaggedRequest(FetchRemoteActions),
	Rpc.fromTaggedRequest(SendLocalActions)
) {}

// Define the Union Schema for all requests
export const SyncNetworkRpcSchema = Schema.Union(FetchRemoteActions, SendLocalActions)
export type SyncNetworkRpcSchema = Schema.Schema.Type<typeof SyncNetworkRpcSchema>