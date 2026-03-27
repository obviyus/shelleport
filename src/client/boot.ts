import type { AppRoute } from "~/client/routes";
import type { HostSession, ProviderSummary, SessionDetail } from "~/shared/shelleport";

type UnauthenticatedBootData = {
	authenticated: false;
	defaultCwd: string;
	route: AppRoute;
};

type AuthenticatedBootData = {
	authenticated: true;
	defaultCwd: string;
	providers: ProviderSummary[];
	route: AppRoute;
	sessionDetail: SessionDetail | null;
	sessions: HostSession[];
};

export type AppBootData = AuthenticatedBootData | UnauthenticatedBootData;
