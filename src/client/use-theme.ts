import { useCallback, useSyncExternalStore } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "shelleport.theme";

function getStoredTheme(): Theme {
	if (typeof window === "undefined") {
		return "dark";
	}

	const stored = localStorage.getItem(STORAGE_KEY);

	if (stored === "light" || stored === "dark") {
		return stored;
	}

	return "dark";
}

function applyTheme(theme: Theme) {
	const root = document.documentElement;
	root.classList.remove("dark", "light");
	root.classList.add(theme);
}

let currentTheme: Theme = getStoredTheme();

if (typeof window !== "undefined") {
	applyTheme(currentTheme);
}

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

function getSnapshot() {
	return currentTheme;
}

function setTheme(theme: Theme) {
	currentTheme = theme;
	localStorage.setItem(STORAGE_KEY, theme);
	applyTheme(theme);

	for (const listener of listeners) {
		listener();
	}
}

export function useTheme() {
	const theme = useSyncExternalStore(subscribe, getSnapshot, () => "dark" as Theme);

	const toggleTheme = useCallback(() => {
		setTheme(theme === "dark" ? "light" : "dark");
	}, [theme]);

	return { theme, toggleTheme } as const;
}
