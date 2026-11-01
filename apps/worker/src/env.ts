/**
 * Variables that pick who pays for a `claude` call. Any of them left in the child's environment would win
 * over (or redirect) the curator's subscription token, so all are removed before the one we want is set.
 */
const BILLING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/** The environment for a `claude` child process: `base` minus every billing variable, plus the OAuth token. */
export function spawnEnv(base: NodeJS.ProcessEnv, credential: string): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of BILLING_VARS) delete env[name];
  env.CLAUDE_CODE_OAUTH_TOKEN = credential;
  return env;
}
