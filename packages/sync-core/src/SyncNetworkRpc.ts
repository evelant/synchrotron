import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"
import { HLC } from "./HLC"
import { ActionModifiedRow, ActionRecord } from "./models"
import { NetworkRequestError, RemoteActionFetchError } from "./SyncNetworkService"

const FetchResultSchema = Schema.Struct({
	actions: Schema.Array(ActionRecord.json),
	modifiedRows: Schema.Array(ActionModifiedRow.json)
})

export class FetchRemoteActions extends Schema.TaggedRequest<FetchRemoteActions>()(
	"FetchRemoteActions",
	{
		payload: {
			clientId: Schema.String,
			lastSyncedClock: HLC
		},
		success: FetchResultSchema,
		failure: RemoteActionFetchError
	}
) {}

export class SendLocalActions extends Schema.TaggedRequest<SendLocalActions>()("SendLocalActions", {
	payload: {
		clientId: Schema.String,
		actions: Schema.Array(ActionRecord),
		amrs: Schema.Array(ActionModifiedRow)
	},
	success: Schema.Boolean,
	failure: NetworkRequestError
}) {}

export class SyncNetworkRpcGroup extends RpcGroup.make(
	Rpc.fromTaggedRequest(FetchRemoteActions),
	Rpc.fromTaggedRequest(SendLocalActions)
) {}
