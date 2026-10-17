declare const __AGENT_VERSION__: string | undefined;

/** Set when the agent is bundled for download (tsup `define`); "dev" when run from source. */
export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : 'dev';
