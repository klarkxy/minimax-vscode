/** Hard upper bound for tool definitions per request. See consts.ts. */
export { MINIMAX_TOOLS_LIMIT as DEEPSEEK_TOOLS_LIMIT } from '../../consts';

/** Tools whose names start with this are treated as "activate_*" virtual tools. */
export const ACTIVATE_TOOL_PREFIX = 'activate_';

/** Prefix for synthetic tool call IDs emitted during preflight. */
export const PREFLIGHT_ACTIVATE_CALL_ID_PREFIX = 'minimax_preflight_activate_';

/** Maximum number of preflight rounds per user request. */
export const MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST = 3;

/** Sentinels used to detect/filter our own provider-emitted tool-drift notices. */
export const TOOL_DRIFT_NOTICE_START = '[minimax-copilot-tool-drift-notice-start]: #';
export const TOOL_DRIFT_NOTICE_END = '[minimax-copilot-tool-drift-notice-end]: #';
