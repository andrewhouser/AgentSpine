/**
 * Refused calls (D2): denials that no approval could have changed, told apart from ordinary ones by the exact text
 * the broker starts their audit row with (REFUSED_PREFIX in src/broker.ts; test/refused-web.test.mjs pins the two).
 */
export const REFUSED_PREFIX = "DENIED (refused, whoever approves):";

/** Whether an audit row's output is a refusal rather than an ordinary denial. */
export const isRefused = (output: null | string | undefined): boolean => typeof output === "string" && output.startsWith(REFUSED_PREFIX);
