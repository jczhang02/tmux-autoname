import { basename } from "node:path";

export function slugify(input: string, fallback = "work"): string {
	const normalized = input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return normalized.length > 0 ? normalized : fallback;
}

export function clampName(tool: string, slug: string, maxLen: number): string {
	const safeTool = slugify(tool, "tool");
	const maxSlugLen = Math.max(4, maxLen - safeTool.length - 1);
	const safeSlug = slugify(slug, "work");
	const trimmed =
		safeSlug.length > maxSlugLen
			? safeSlug.slice(0, maxSlugLen).replace(/-+$/g, "")
			: safeSlug;
	return `${safeTool}:${trimmed || "work"}`;
}

export function stripTestPath(path: string): string {
	const file = basename(path).replace(/\.[^.]+$/, "");
	return file
		.replace(/^test[-_]/, "")
		.replace(/[-_]test$/, "")
		.replace(/^spec[-_]/, "")
		.replace(/[-_]spec$/, "");
}
