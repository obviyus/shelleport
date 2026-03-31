import type { ProviderId } from "~/shared/shelleport";
import { ClaudeProviderAdapter } from "~/server/providers/claude.server";
import { CodexProviderAdapter } from "~/server/providers/codex.server";
import type { ProviderAdapter } from "~/server/providers/provider.server";

const providers: Record<ProviderId, ProviderAdapter> = {
	claude: new ClaudeProviderAdapter(),
	codex: new CodexProviderAdapter(),
};

export function listProviders() {
	return Object.values(providers).map((provider) => provider.summary());
}

export function getProvider(providerId: ProviderId) {
	return providers[providerId];
}
