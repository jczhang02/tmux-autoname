import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BadgeStyle } from "./domain";

const credentialSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("onepassword"), ref: z.string().startsWith("op://") }).strict(),
  z.object({
    source: z.literal("keyring"),
    service: z.string().min(1),
    account: z.string().min(1),
  }).strict(),
  z.object({
    source: z.literal("keychain"),
    service: z.string().min(1),
    account: z.string().min(1),
  }).strict(),
  z
    .object({ source: z.literal("env"), name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) })
    .strict(),
]);

const aiSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "openai-compatible"]),
    model: z.string().min(1),
    base_url: z.string().url().optional(),
    supports_structured_outputs: z.boolean().default(true),
    confidence_threshold: z.number().min(0).max(1).default(0.6),
    credential: credentialSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "openai-compatible" && !value.base_url) {
      ctx.addIssue({
        code: "custom",
        path: ["base_url"],
        message: "base_url is required for openai-compatible",
      });
    }
    if (value.provider !== "openai-compatible" && !value.credential) {
      ctx.addIssue({
        code: "custom",
        path: ["credential"],
        message: "credential is required for native providers",
      });
    }
  });

const configSchema = z.object({
  ai: aiSchema.optional(),
  display: z
    .object({ profile: z.string().min(1).default("{activity}:{scope}/{task}") }).strict()
    .default({ profile: "{activity}:{scope}/{task}" }),
  limits: z
    .object({
      debounce_ms: z.number().int().nonnegative().default(1000),
      scan_interval_ms: z.number().int().positive().default(3000),
      content_settle_ms: z.number().int().nonnegative().default(4000),
      minimum_call_interval_ms: z.number().int().nonnegative().default(10000),
      request_timeout_ms: z.number().int().positive().default(4000),
      max_calls_per_window_hour: z.number().int().positive().default(6),
      max_calls_per_server_hour: z.number().int().positive().default(30),
      circuit_failure_threshold: z.number().int().positive().default(3),
      circuit_cooldown_ms: z.number().int().positive().default(600000),
    })
    .strict()
    .default({
      debounce_ms: 1000,
      scan_interval_ms: 3000,
      content_settle_ms: 4000,
      minimum_call_interval_ms: 10000,
      request_timeout_ms: 4000,
      max_calls_per_window_hour: 6,
      max_calls_per_server_hour: 30,
      circuit_failure_threshold: 3,
      circuit_cooldown_ms: 600000,
    }),
}).strict();

export type CredentialReference = z.infer<typeof credentialSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export const defaultConfig = (): AppConfig => configSchema.parse({});

export const configPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.TMUX_AUTONAME_CONFIG ??
  join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tmux-autoname", "config.toml");

export const loadConfig = async (
  path = configPath(),
  readFile: (path: string) => Promise<string> = (file) => Bun.file(file).text(),
): Promise<AppConfig> => {
  try {
    const text = await readFile(path);
    return configSchema.parse(Bun.TOML.parse(text));
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    if (error instanceof TypeError && error.message.includes("ENOENT")) {
      return defaultConfig();
    }
    throw error;
  }
};

export const badgeStyle = (value: string | undefined): BadgeStyle =>
  value === "nerd" ? "nerd" : "plain";

export const credentialCommand = (
  reference: CredentialReference,
): { command: string[]; env?: Record<string, string> } => {
  switch (reference.source) {
    case "onepassword":
      return { command: ["op", "read", "--no-newline", reference.ref] };
    case "keyring":
      return {
        command: [
          "secret-tool",
          "lookup",
          "service",
          reference.service,
          "account",
          reference.account,
        ],
      };
    case "keychain":
      if (platform() !== "darwin") throw new Error("keychain is available only on macOS");
      return {
        command: [
          "security",
          "find-generic-password",
          "-w",
          "-s",
          reference.service,
          "-a",
          reference.account,
        ],
      };
    case "env":
      return { command: [] };
  }
};
