// Fake values for the variables whose values the evaluator masks in its output.
export const EVALUATOR_SECRETS = {
  OPENROUTER_API_KEY: 'sk-or-v1-fakeOpenRouterKey0123456789',
  OPENAI_API_KEY: 'sk-proj-fakeOpenAiKey0123456789',
  SONAR_TOKEN: 'squ_fakeSonarToken0123456789',
  GITHUB_TOKEN: 'ghs_fakeGithubToken0123456789'
};

export const SECRET_NAMES = Object.keys(EVALUATOR_SECRETS) as Array<keyof typeof EVALUATOR_SECRETS>;

/** Runs with the given variables set (undefined unsets one), then restores the environment. */
export async function withEnvironment<T>(values: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  const assign = (entries: Record<string, string | undefined>) => Object.entries(entries).forEach(([name, value]) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  assign(values);
  try {
    return await run();
  } finally {
    assign(previous);
  }
}

export function withEvaluatorSecrets<T>(run: () => T | Promise<T>): Promise<T> {
  return withEnvironment(EVALUATOR_SECRETS, run);
}
