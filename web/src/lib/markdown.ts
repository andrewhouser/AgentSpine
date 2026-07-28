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

export const renderMarkdown = (text: string): string => md.render(text);
