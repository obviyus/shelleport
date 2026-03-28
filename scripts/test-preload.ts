import { randomUUIDv7 } from "bun";

if (!Bun.env.SHELLEPORT_DATA_DIR) {
	Bun.env.SHELLEPORT_DATA_DIR = `${Bun.env.TMPDIR ?? "/tmp"}/shelleport-test-${randomUUIDv7()}`;
}
