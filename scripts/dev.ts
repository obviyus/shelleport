import { runServe } from "../server";

await Bun.$`bun run ./scripts/build.ts`;
await runServe();
