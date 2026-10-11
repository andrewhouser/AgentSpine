/**
 * Markdown rendering for assistant output.
 *
 * `html: false` is the whole security story and it is not a preference. Assistant text
 * routinely quotes UNTRUSTED material — web pages, email snippets, file contents — and
 * markdown-it with HTML disabled *escapes* raw tags rather than passing them through, so
 * there is no sanitizer to misconfigure and no `dangerouslySetInnerHTML` reachable by
 * anything a fetched page said. Do not turn it on.
 *
 * `linkify` is off for the same reason: auto-linking untrusted text turns a quoted string
 * into something clickable, which is a phishing surface the model never intended to create.
 * Links the assistant writes deliberately, in markdown syntax, still work.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: false,
  typographer: false,
});

// Anything the assistant does link to opens away from the app, and carries no referrer.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("rel", "noopener noreferrer nofollow");
  tokens[idx].attrSet("target", "_blank");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * Images are allowed for ONE thing: PNGs this app generated and serves at /images/.
 *
 * markdown-it's default image rule renders `<img>` for any `src`, and that is a real
 * hazard here for the same reason `html` and `linkify` are off — assistant text quotes
 * untrusted material, and an `<img src="http://tracker/x.png">` smuggled out of a fetched
 * page is a beacon that fires on render, with no click required. So the rule is narrowed
 * rather than left at its default: an image whose `src` is a same-origin `/images/...` path
 * renders; anything else (absolute URL, protocol-relative, a `..` traversal, a data: URI)
 * is dropped to its alt text. This is the deliberately narrow grant the generate_image
 * tool's stable `/images/<uuid>.png` URLs need, and nothing wider.
 */
const isOwnImage = (src: string): boolean =>
  // Must be an app-root-relative /images/ path. Reject protocol-relative //host, any scheme,
  // and any "/images/../" that climbs out. No leading whitespace tricks.
  /^\/images\/[A-Za-z0-9._-]+$/.test(src);

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  // The alt text, rendered as plain text — used either as the <img>'s alt or as the whole
  // fallback when the src is rejected.
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  if (!isOwnImage(src)) {
    // Not one of ours — render the alt text as escaped plain text instead of an <img>.
    return md.utils.escapeHtml(alt);
  }
  // "alt" must be set (markdown-it invariant); populate it from the children like the
  // default rule does, then constrain display so a 768px PNG doesn't blow out the column.
  token.attrSet("alt", alt);
  token.attrSet("loading", "lazy");
  token.attrSet("style", "max-width:100%;height:auto;border-radius:6px");
  return self.renderToken(tokens, idx, options);
};

export const renderMarkdown = (text: string): string => md.render(text);
