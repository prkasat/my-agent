import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const packagesDir = "packages";

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const packageDir = join(packagesDir, entry.name);
	rmSync(join(packageDir, "dist"), { recursive: true, force: true });
	rmSync(join(packageDir, "tsconfig.tsbuildinfo"), { force: true });
}
