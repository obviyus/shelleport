import {
	getDefaultEffortLevel,
	normalizeEffortLevel,
	type EffortLevel,
	type ProviderModel,
} from "~/shared/shelleport";

const LAST_MODEL_KEY = "shelleport.last-model";
const LAST_EFFORT_KEY = "shelleport.last-effort";

function readStorage(key: string): string | null {
	try {
		return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
	} catch {
		return null;
	}
}

function parseEffortLevel(value: string | null): EffortLevel | null {
	if (value === "low" || value === "medium" || value === "high" || value === "max") {
		return value;
	}

	return null;
}

export function readLastSessionPreferences(
	models: ProviderModel[],
	fallbackModel: string | null,
): { model: string | null; effort: EffortLevel } {
	const storedModel = readStorage(LAST_MODEL_KEY);
	const model =
		storedModel && models.some((entry) => entry.id === storedModel) ? storedModel : fallbackModel;
	const effort =
		normalizeEffortLevel(model, parseEffortLevel(readStorage(LAST_EFFORT_KEY)), models) ??
		getDefaultEffortLevel(model, models) ??
		"medium";
	return { model, effort };
}

export function writeLastSessionPreferences(
	model: string | null,
	effort: EffortLevel | null,
	models?: ProviderModel[],
) {
	try {
		if (model) {
			window.localStorage.setItem(LAST_MODEL_KEY, model);
		}
		window.localStorage.setItem(
			LAST_EFFORT_KEY,
			normalizeEffortLevel(model, effort, models) ??
				getDefaultEffortLevel(model, models) ??
				"medium",
		);
	} catch {}
}
