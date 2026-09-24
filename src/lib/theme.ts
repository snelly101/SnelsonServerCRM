export const THEME_COOKIE = "crm-theme";
export const THEME_PREFS = ["system", "light", "dark"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

export function parseThemePref(v: string | null | undefined): ThemePref {
  return v === "light" || v === "dark" ? v : "system";
}

/**
 * Runs before first paint. Resolves "system" with prefers-color-scheme and
 * keeps following the OS while no explicit preference is set. The server
 * already rendered data-theme for explicit light/dark, so the script only
 * has work to do for "system".
 */
export const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var p=d.getAttribute('data-theme-pref')||'system';var mq=window.matchMedia('(prefers-color-scheme: dark)');function apply(){var pref=d.getAttribute('data-theme-pref')||'system';d.setAttribute('data-theme',pref==='system'?(mq.matches?'dark':'light'):pref);}apply();mq.addEventListener('change',apply);}catch(e){}})();`;
