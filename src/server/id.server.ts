export function createId() {
	return Bun.randomUUIDv7();
}

export function createTimestamp() {
	return Date.now();
}
