export function canonicalConversation(raw: string) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP(S) conversation URL without credentials.");
  url.hash = "";
  return url.href.replace(/\/$/, "");
}
