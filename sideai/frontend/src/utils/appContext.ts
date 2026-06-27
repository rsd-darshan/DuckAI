/** Detect email vs coding vs browser context — keep in sync with backend app_context.py */

const EMAIL_URL_RE =
  /mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com|mail\.proton\.me|webmail\./i;

const NON_EMAIL_URL_RE =
  /neetcode\.io|leetcode\.com|hackerrank\.com|codewars\.com|github\.com|gitlab\.com|stackoverflow\.com|youtube\.com|youtu\.be/i;

const GMAIL_TITLE_RE = /\bgmail\b|mail\.google\.com|inbox\s*[\(-]/i;

const OUTLOOK_TITLE_RE = /\boutlook\b.*(@|\||-)|microsoft outlook/i;

const MAIL_APP_RE = /^(mail|apple mail|thunderbird|superhuman|microsoft outlook)$/i;

const CODING_TEXT_RE =
  /neetcode\.io|leetcode\.com|hackerrank|codewars|products of array|submissions|discuss\s+question|run\s+code|submit\s+solution/i;

function norm(s: string) {
  return (s || "").trim();
}

export function isCodingContext(
  activeApp = "",
  windowTitle = "",
  url = "",
  visibleText = ""
): boolean {
  const blob = `${norm(activeApp)} ${norm(windowTitle)} ${url} ${norm(visibleText).slice(0, 600)}`.toLowerCase();
  if (NON_EMAIL_URL_RE.test(blob) && !EMAIL_URL_RE.test(blob)) return true;
  if (CODING_TEXT_RE.test(blob)) return true;
  const title = norm(windowTitle).toLowerCase();
  if (title.includes("neetcode") || title.includes("leetcode")) return true;
  return false;
}

export function isEmailContext(
  activeApp = "",
  windowTitle = "",
  url = "",
  visibleText = ""
): boolean {
  const app = norm(activeApp);
  const title = norm(windowTitle);
  const u = norm(url);
  const snippet = norm(visibleText).slice(0, 800);

  if (isCodingContext(app, title, u, snippet)) return false;

  if (u) {
    if (EMAIL_URL_RE.test(u)) return true;
    if (NON_EMAIL_URL_RE.test(u)) return false;
  }

  const appKey = app.toLowerCase();
  if (MAIL_APP_RE.test(appKey) || appKey === "mail" || appKey === "thunderbird" || appKey === "superhuman") {
    return true;
  }
  if (appKey.includes("outlook") && !appKey.includes("visual studio")) return true;

  if (GMAIL_TITLE_RE.test(title)) return true;
  if (OUTLOOK_TITLE_RE.test(title)) return true;

  if (snippet) {
    const low = snippet.toLowerCase();
    if (low.includes("mail.google.com")) return true;
    if (low.includes("inbox") && low.includes("compose") && low.includes("gmail")) return true;
  }

  return false;
}

export function isBrowserContext(activeApp = "", windowTitle = ""): boolean {
  const blob = `${norm(activeApp)} ${norm(windowTitle)}`.toLowerCase();
  return ["chrome", "safari", "firefox", "arc", "brave", "edge", "opera", "vivaldi", "chromium"].some(
    (b) => blob.includes(b)
  );
}
