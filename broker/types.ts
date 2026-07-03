/**
 * Shared event shape passed from the HTTP server through dispatch to the
 * adapters (spawn-runner today; MCP pull adapter in a later phase).
 */
export interface WebhookEvent {
	hook: string;
	receivedAt: string;
	headers: Record<string, string>;
	body: unknown;
}
