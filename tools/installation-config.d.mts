export function installationConfig(
	env: Record<string, string | undefined>,
	requireLive?: boolean,
): { accountId?: string; artifactsNamespace: string; workerName: string; origin: string; domain?: string };
