/**
 * Per-project policy narrowing — intersection only, never a grant.
 *
 * A project can be given a tighter policy than the global one: fewer domains, fewer
 * directories, smaller budgets, dry-run forced on. It can never be given a *wider* one,
 * and that is a property of this function rather than a convention people follow.
 *
 * The reason is the threat model. `policy.json` lives on disk and is edited by hand; a
 * project's overlay is a row in the database, reachable from the dashboard API — which the
 * agent itself can talk to. If an overlay could add a domain to `web.fetchAllowlist`, then
 * "create a project" would become a privilege-escalation primitive, and the deny-by-default
 * boundary would only be as strong as every route that can write a project row.
 *
 * So every rule here moves in one direction:
 *
 *   allowlists   intersected — an overlay may remove entries, never introduce them
 *   booleans     AND-ed — an overlay may switch a capability off, never on
 *   budgets      minimum — an overlay may lower a cap, never raise one (absent = no cap,
 *                so an overlay setting a cap where there was none is a *narrowing*)
 *   dryRun       OR-ed — an overlay may force dry-run on, never off
 *
 * Pure and dependency-free so it can be tested exhaustively. See test/narrow-policy.test.mjs.
 */
import type { Policy } from "../types.ts";

/** The subset of Policy an overlay may speak about. Everything is optional. */
export type PolicyOverlay = {
  apps?: { allow?: string[] };
  autoExecute?: { dryRun?: boolean; irreversibleAlwaysConfirm?: boolean; reversible?: boolean };
  browser?: { enabled?: boolean; navigateAllowlist?: string[]; neverDomains?: string[] };
  budgets?: {
    perDay?: { default?: number; tools?: Record<string, number> };
    perRun?: { default?: number; tools?: Record<string, number> };
  };
  drafts?: { enabled?: boolean };
  fs?: { readableDirs?: string[]; writableDirs?: string[] };
  git?: { repoDirs?: string[] };
  google?: { enabled?: boolean };
  instagram?: { enabled?: boolean; publish?: boolean };
  schedules?: { enabled?: boolean };
  subagents?: { enabled?: boolean };
  weather?: { enabled?: boolean };
  web?: { fetchAllowlist?: string[]; searchEnabled?: boolean };
};

/** Keep only entries present in both. An overlay listing something new does not add it. */
const intersect = (base: string[] | undefined, overlay: string[] | undefined): string[] => {
  const b = base ?? [];
  if (!overlay) return [...b];
  return b.filter((entry) => overlay.includes(entry));
};

/**
 * An empty allowlist means "deny everything" — except for `browser.navigateAllowlist`,
 * where `[]` conventionally means "any domain". Intersecting with that convention would
 * invert it, turning a restriction into a grant, so it is handled explicitly.
 *
 * Two non-empty lists that share nothing intersect to `[]`, which the page tools would read
 * as "any domain". That is the one result `[]` cannot carry, so it is returned as `denyAll`
 * and the tools test the flag before the list.
 */
const intersectNavigate = (
  base: string[] | undefined,
  overlay: string[] | undefined,
): { denyAll: boolean; list: string[] } => {
  const b = base ?? [];
  if (!overlay) return { denyAll: false, list: [...b] };
  if (b.length === 0) return { denyAll: false, list: [...overlay] }; // base allowed anything; the overlay restricts it
  if (overlay.length === 0) return { denyAll: false, list: [...b] }; // overlay says "any" — no narrowing offered
  const list = b.filter((entry) => overlay.includes(entry));
  return { denyAll: list.length === 0, list };
};

/** True only if both are true. An overlay can switch something off, never on. */
const and = (base: boolean | undefined, overlay: boolean | undefined): boolean =>
  Boolean(base) && (overlay === undefined ? true : Boolean(overlay));

/** The tighter cap. 0/absent means unlimited, so a real number always wins over it. */
const tighter = (base: number | undefined, overlay: number | undefined): number | undefined => {
  const b = base && base > 0 ? base : undefined;
  const o = overlay && overlay > 0 ? overlay : undefined;
  if (b === undefined) return o;
  if (o === undefined) return b;
  return Math.min(b, o);
};

/**
 * Budgets, compared as what the broker will actually apply. `capFor` in broker.ts uses a tool's
 * own cap when it has one and the scope's default otherwise, so a tool cap is not comparable
 * with the other side's cap for the same tool alone: a base default of 2 with an overlay
 * `web_search: 100` would otherwise let web_search run 100 times. Each tool therefore gets the
 * tighter of the two EFFECTIVE caps, and an overlay can never end up above the base.
 */
const narrowScope = (
  base: { default?: number; tools?: Record<string, number> } | undefined,
  overlay: { default?: number; tools?: Record<string, number> } | undefined,
): { default?: number; tools?: Record<string, number> } | undefined => {
  if (!base && !overlay) return undefined;
  const effective = (scope: typeof base, tool: string): number | undefined => scope?.tools?.[tool] ?? scope?.default;
  const tools: Record<string, number> = {};
  for (const tool of new Set([...Object.keys(base?.tools ?? {}), ...Object.keys(overlay?.tools ?? {})])) {
    const value = tighter(effective(base, tool), effective(overlay, tool));
    if (value !== undefined) tools[tool] = value;
  }
  const dflt = tighter(base?.default, overlay?.default);
  return { ...(dflt !== undefined ? { default: dflt } : {}), ...(Object.keys(tools).length ? { tools } : {}) };
};

export const narrowPolicy = (base: Policy, overlay?: null | PolicyOverlay): Policy => {
  if (!overlay) return base;

  return {
    ...base,
    apps: { allow: intersect(base.apps?.allow, overlay.apps?.allow) },
    autoExecute: {
      // dryRun is the one field where TRUE is the restrictive value, so it is OR-ed rather
      // than AND-ed: an overlay may force a project into dry-run, never force it out.
      dryRun: Boolean(base.autoExecute?.dryRun) || Boolean(overlay.autoExecute?.dryRun),
      // Likewise "always confirm" — an overlay may demand more confirmation, not less.
      irreversibleAlwaysConfirm:
        Boolean(base.autoExecute?.irreversibleAlwaysConfirm) ||
        Boolean(overlay.autoExecute?.irreversibleAlwaysConfirm),
      reversible: and(base.autoExecute?.reversible, overlay.autoExecute?.reversible),
    },
    browser: (() => {
      const nav = intersectNavigate(base.browser?.navigateAllowlist, overlay.browser?.navigateAllowlist);
      const never = [...new Set([...(base.browser?.neverDomains ?? []), ...(overlay.browser?.neverDomains ?? [])])];
      return {
        // Once denied, always denied: the base may already carry the flag.
        ...(nav.denyAll || base.browser?.denyAll ? { denyAll: true } : {}),
        enabled: and(base.browser?.enabled, overlay.browser?.enabled),
        navigateAllowlist: nav.list,
        // The one browser list that grows under an overlay: it refuses, so a project may add
        // a site it must never touch and can never take one of yours away (section 12, D2).
        ...(never.length ? { neverDomains: never } : {}),
      };
    })(),
    budgets: {
      perDay: narrowScope(base.budgets?.perDay, overlay.budgets?.perDay),
      perRun: narrowScope(base.budgets?.perRun, overlay.budgets?.perRun),
    },
    drafts: { ...base.drafts, enabled: and(base.drafts?.enabled, overlay.drafts?.enabled) },
    fs: {
      readableDirs: intersect(base.fs?.readableDirs, overlay.fs?.readableDirs),
      writableDirs: intersect(base.fs?.writableDirs, overlay.fs?.writableDirs),
    },
    git: { repoDirs: intersect(base.git?.repoDirs, overlay.git?.repoDirs) },
    google: { enabled: and(base.google?.enabled, overlay.google?.enabled) },
    // A project run reaches Instagram only when the overlay says so in as many words. Every other
    // section here treats an overlay's silence as "no change"; this one does not, because the
    // surface writes to a public account and a project that never mentions it has no business there.
    ...(base.instagram
      ? {
          instagram: {
            ...base.instagram,
            enabled: Boolean(base.instagram.enabled) && overlay.instagram?.enabled === true,
            publish: base.instagram.publish === true && overlay.instagram?.publish === true,
          },
        }
      : {}),
    schedules: { enabled: and(base.schedules?.enabled, overlay.schedules?.enabled) },
    subagents: { enabled: and(base.subagents?.enabled, overlay.subagents?.enabled) },
    weather: { enabled: and(base.weather?.enabled, overlay.weather?.enabled) },
    web: {
      fetchAllowlist: intersect(base.web?.fetchAllowlist, overlay.web?.fetchAllowlist),
      searchEnabled: and(base.web?.searchEnabled, overlay.web?.searchEnabled),
    },
  };
};
