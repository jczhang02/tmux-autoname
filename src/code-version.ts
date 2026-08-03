import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function codeVersion(projectRoot: string): string {
	const files = [
		join(projectRoot, "bin", "tmux-autoname.ts"),
		...readdirSync(join(projectRoot, "src"), { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => join(projectRoot, "src", entry.name))
			.sort(),
	];
	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(path.slice(projectRoot.length));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}
