import { Context } from "effect";
declare const ClientIdOverride_base: Context.TagClass<ClientIdOverride, "ClientIdOverride", string>;
/**
 * Service tag for overriding the client ID in tests
 * This allows tests to specify a client ID without modifying the ClockService interface
 */
export declare class ClientIdOverride extends ClientIdOverride_base {
}
export {};
//# sourceMappingURL=ClientIdOverride.d.ts.map