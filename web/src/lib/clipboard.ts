/**
 * Put text on the clipboard. Returns whether it worked.
 *
 * `navigator.clipboard` exists only on a secure origin, and this dashboard is usually opened
 * over plain HTTP from another machine on the LAN, where the property is simply undefined. The
 * old textarea-and-`execCommand` route still works there, so it is the fallback rather than an
 * afterthought: without it "Copy" would do nothing on exactly the setup this project assumes.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied, or the page is not focused: fall through to the older route */
  }

  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.opacity = "0";
  el.style.position = "fixed";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    el.remove();
  }
};
