import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"
import { ActionModifiedRow, ActionRecord } from "./models"
import { NetworkRequestError, RemoteActionFetchError } from "./SyncNetworkService"

const FetchResultSchema = Schema.Struct({
	actions: Schema.Array(ActionRecord),
	modifiedRows: Schema.Array(ActionModifiedRow)
})

export class FetchRemoteActions extends Schema.TaggedRequest<FetchRemoteActions>()(
	"FetchRemoteActions",
	{
		payload: {
			clientId: Schema.String,
			sinceServerIngestId: Schema.Number
		},
		success: FetchResultSchema,
		failure: RemoteActionFetchError
	}
) {}

export class SendLocalActions extends Schema.TaggedRequest<SendLocalActions>()("SendLocalActions", {
	payload: {
		clientId: Schema.String,
		basisServerIngestId: Schema.Number,
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
