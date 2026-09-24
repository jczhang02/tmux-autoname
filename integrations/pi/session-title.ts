/**
 * tmux-autoname pi integration.
 *
 * pi sessions with no name show "π - <cwd>" in tmux, which tmux-autoname
 * treats as unnamed (see docs/adr/0004-mirror-agent-titles.md). This
 * extension gives pi windows the same behaviour as Claude Code windows:
 * after the first agent turn, if the session still has no name, it asks
 * the current model for a short title of the user's goal and calls
 * pi.setSessionName() with it. All failures are silent - this is a
 * cosmetic nicety, never something that should interrupt a session.
 *
 * Install: point pi at this file with `-e` or add it to your pi config's
 * extensions list. See /README.md for details.
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const MAX_WORDS = 6;

const SYSTEM_PROMPT =
	`Write a short title, at most ${MAX_WORDS} words, for the user's goal in the message below. ` +
	"Use the same language as the user. Respond with only the title: no quotes, no trailing " +
	"punctuation, no preamble.";

function firstUserMessageText(branch: SessionEntry[]): string | undefined {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const { content } = entry.message;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
					return String((part as { text: unknown }).text);
				}
			}
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		try {
			if (pi.getSessionName()) return;
			if (!ctx.model) return;

			const goal = firstUserMessageText(ctx.sessionManager.getBranch());
			if (!goal) return;

			const response = await ctx.modelRegistry.complete(
				ctx.model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: goal }],
							timestamp: Date.now(),
						},
					],
				},
				{ cacheRetention: "none", sessionId: uuidv7() },
			);

			const title = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ")
				.trim();

			if (title && !pi.getSessionName()) {
				pi.setSessionName(title);
			}
		} catch {
			// Fail silently: naming the session is a nicety, not a requirement.
		}
	});
}
