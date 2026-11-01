/**
 * Copies text to the clipboard. The Clipboard API is missing where the page isn't a secure context,
 * e.g. when the server's UI is opened over plain HTTP, and some webviews refuse it. Copying a
 * selection works there.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (focused instanceof HTMLElement) focused.focus();
  if (!copied) throw new Error("Couldn't copy to the clipboard");
}
