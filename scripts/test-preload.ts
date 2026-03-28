import { join } from "node:path";
import { randomUUIDv7 } from "bun";

if (!Bun.env.SHELLEPORT_DATA_DIR) {
	const testDataDir = join(Bun.env.TMPDIR ?? "/tmp", `shelleport-test-${randomUUIDv7()}`);
	Bun.env.SHELLEPORT_DATA_DIR = testDataDir;
}
