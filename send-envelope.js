#!/usr/bin/env node
// Send your first envelope with the Docusign eSignature REST API.
//
// One file, no SDK, no dependencies: Node.js 20.12+ and its built-in fetch.
// It follows the tutorial in order:
//
//   1  sign in and approve access          Authorization Code Grant
//   2  exchange the code for a token       POST /oauth/token
//   3  your account ID and base URI        GET  /oauth/userinfo
//   4  build the envelope definition       a PDF, a recipient, a tab, a status
//   5  send it                             POST /restapi/v2.1/accounts/{accountId}/envelopes
//
//   npm start                    send the envelope (status "sent", anchor tab)
//   npm start -- --draft         status "created": saved as a draft, nothing sent
//   npm start -- --revised       the revised PDF: its signature block moved down
//   npm start -- --absolute      place the tab by x/y instead of the anchor string
//   npm start -- --dry-run       build and print the envelope definition; send nothing
//   npm run status [envelopeId]  check an envelope's status (the last one sent, by default)
//
// Setup: copy .env.example to .env and fill it in. See README.md.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(HERE, ".env"));
} catch {
  // no .env file: read the settings from the environment instead
}

/* ── settings ────────────────────────────────────────────────────────────── */

const env = (name, fallback = "") => process.env[name]?.trim() || fallback;

const CONFIG = {
  integrationKey: env("DOCUSIGN_INTEGRATION_KEY"),
  secretKey: env("DOCUSIGN_SECRET_KEY"),
  redirectUri: env("DOCUSIGN_REDIRECT_URI", "http://localhost:3001/callback"),
  // developer accounts sign in at account-d.docusign.com; production at account.docusign.com
  authServer: env("DOCUSIGN_AUTH_SERVER", "https://account-d.docusign.com"),
  signerName: env("SIGNER_NAME"),
  signerEmail: env("SIGNER_EMAIL"),
  document: env("DOCUMENT_PATH"),
  maskIds: env("MASK_IDS", "true") !== "false",
};

const SESSION_FILE = path.join(HERE, ".session.json");

/**
 * Where the signature line is in documents/fontara-nda.pdf, in points from the
 * page's top-left. Right for that PDF; wrong as soon as its text moves — which
 * is the point of --absolute with --revised.
 */
const ABSOLUTE_TAB = { documentId: "1", pageNumber: "1", xPosition: "72", yPosition: "498" };

/** The hidden marker in the PDF. A tab starts at its first character: no offset needed. */
const ANCHOR_TAB = { anchorString: "\\s1\\", anchorUnits: "pixels", anchorXOffset: "0", anchorYOffset: "0" };

/* ── output ──────────────────────────────────────────────────────────────── */

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const cyan = paint("36");

const step = (n, title) => console.log(`\n${bold(`${n}  ${title}`)}`);
const line = (...parts) => console.log(`   ${parts.join(" ")}`);
const ok = (...parts) => line(green("✓"), ...parts);

/** IDs on screen are masked the way Docusign's own docs mask an API Account ID. */
const maskId = (id) => (CONFIG.maskIds && /^[0-9a-f-]{36}$/i.test(id) ? `${id.slice(0, 8)}-xxxx-xxxx-xxxx-${id.slice(-12)}` : id);
const maskEmail = (email) => (CONFIG.maskIds ? email.replace(/^(.)[^@]*/, "$1•••") : email);

/* ── 1 · sign in ─────────────────────────────────────────────────────────── */

// Opens the sign-in URL in the default browser, with no shell in between.
// On Windows this used to run `cmd /c start "" <url>`, and cmd.exe treats `&`
// as a command separator: it cut the URL at the first `&`, so the browser got
// only `?response_type=code`, Docusign had no redirect URI to send you back
// to, and the script never saw the sign-in. rundll32's URL handler takes the
// whole URL as one argument instead.
function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => line(dim("couldn't open a browser; open this in yours:"), url));
  child.unref();
}

/** Serves the redirect URI until Docusign sends the browser back with ?code=. */
function waitForCode(expectedState) {
  const redirect = new URL(CONFIG.redirectUri);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, CONFIG.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const done = (title, message) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(title, message));
        server.close();
      };
      if (error) {
        done("Sign-in didn't complete", `Docusign returned <code>${escapeHtml(error)}</code>. Check the terminal.`);
        reject(new Error(`sign-in returned "${error}"${url.searchParams.get("error_description") ? `: ${url.searchParams.get("error_description")}` : ""}`));
      } else if (!code || state !== expectedState) {
        done("Something's off", "This redirect didn't come from the sign-in this script started. Run it again.");
        reject(new Error("the redirect had no code, or a state that doesn't match this sign-in"));
      } else {
        done("Signed in", "You can close this tab and go back to the terminal.");
        resolve(code);
      }
    });
    server.on("error", (err) => reject(new Error(`can't listen on ${redirect.host}: ${err.message}`)));
    server.listen(Number(redirect.port) || 80, redirect.hostname);
    setTimeout(() => {
      server.close();
      reject(new Error("no sign-in after 5 minutes"));
    }, 5 * 60 * 1000).unref();
  });
}

async function signIn() {
  step(1, "Sign in and approve access");
  line(dim("Authorization Code Grant · the sign-in opens in your browser"));
  const state = randomBytes(16).toString("hex");
  const url = new URL("/oauth/auth", CONFIG.authServer);
  url.search = new URLSearchParams({
    response_type: "code",
    scope: "signature",
    client_id: CONFIG.integrationKey,
    redirect_uri: CONFIG.redirectUri,
    state,
    prompt: "login", // always ask, so you sign in as the account you mean
  }).toString();
  const shown = new URL(url);
  shown.searchParams.set("client_id", maskId(CONFIG.integrationKey));
  shown.searchParams.delete("state");
  line(cyan(decodeURIComponent(shown.toString())));
  line(dim(`waiting for the redirect to ${CONFIG.redirectUri} …`));
  const code = waitForCode(state);
  if (!process.argv.includes("--no-open")) openBrowser(url.toString());
  else line(dim("open this in your browser:"), url.toString());
  const received = await code;
  ok("Authorization code received", dim("· valid for 2 minutes, so it's exchanged right away"));
  return received;
}

/* ── 2 · the access token ───────────────────────────────────────────────── */

async function exchangeCode(code) {
  step(2, "Exchange the code for an access token");
  line(dim("POST"), `${CONFIG.authServer}/oauth/token`);
  line(dim("code + integration key + secret key"));
  const res = await fetch(new URL("/oauth/token", CONFIG.authServer), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CONFIG.integrationKey}:${CONFIG.secretKey}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`the token request failed: ${body.error ?? res.status}${body.error_description ? ` (${body.error_description})` : ""}`);
  ok(`Access token received ${dim(`· ${body.access_token.slice(0, 12)}…`)}`, `· expires in ${Math.round(body.expires_in / 3600)} hours`);
  return { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

/* ── 3 · account ID and base URI ─────────────────────────────────────────── */

async function userInfo(accessToken) {
  step(3, "Your account ID and base URI");
  line(dim("GET"), `${CONFIG.authServer}/oauth/userinfo`);
  const res = await fetch(new URL("/oauth/userinfo", CONFIG.authServer), { headers: { Authorization: `Bearer ${accessToken}` } });
  const info = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`userinfo failed: ${info.error ?? res.status}`);
  const account = info.accounts?.find((a) => a.is_default) ?? info.accounts?.[0];
  if (!account) throw new Error("this user has no Docusign accounts");
  line(dim(`accounts[]: ${info.accounts.length} · using the one marked default`));
  ok(`account_id ${maskId(account.account_id)}`);
  ok(`base_uri   ${account.base_uri}`);
  return { accountId: account.account_id, baseUri: account.base_uri };
}

/* ── calls to the eSignature REST API, with backoff on 429 ───────────────── */

class ApiError extends Error {
  constructor(status, body) {
    super(`${status} ${body.errorCode ?? ""}${body.message ? `: ${body.message}` : ""}`.trim());
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Production has rate limits: on 429, wait (Retry-After, or longer each time) instead of retrying rapidly. */
async function api(session, method, apiPath, body) {
  const url = `${session.baseUri}/restapi/v2.1/accounts/${session.accountId}${apiPath}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${session.accessToken}`, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2 ** attempt * 1000;
      line(dim(`429 Too Many Requests · backing off ${wait / 1000}s`));
      await sleep(wait);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data);
    return { status: res.status, data };
  }
}

/* ── 4 · the envelope definition ─────────────────────────────────────────── */

async function buildEnvelope({ draft, absolute, revised }) {
  step(4, "Build the envelope definition");
  const file = CONFIG.document || path.join(HERE, "documents", revised ? "fontara-nda-revised.pdf" : "fontara-nda.pdf");
  const bytes = await readFile(file);
  const documentBase64 = bytes.toString("base64");
  const signHere = absolute ? ABSOLUTE_TAB : ANCHOR_TAB;

  line(dim("documents "), `${path.basename(file)} → documentBase64 "${documentBase64.slice(0, 12)}…"`, dim(`(${bytes.length.toLocaleString("en-US")} bytes, inline)`));
  line(dim("recipients"), `${CONFIG.signerName} <${maskEmail(CONFIG.signerEmail)}> · recipientId "1"`);
  line(
    dim("tabs      "),
    absolute ? `signHereTabs · xPosition ${ABSOLUTE_TAB.xPosition}, yPosition ${ABSOLUTE_TAB.yPosition}` : `signHereTabs · anchorString "${ANCHOR_TAB.anchorString}"`,
  );
  line(dim("status    "), draft ? `"created" ${dim("· saved as a draft, nothing is sent")}` : `"sent" ${dim("· dispatched as soon as it's POSTed")}`);

  return {
    emailSubject: "Please sign the Fontara NDA",
    documents: [{ documentBase64, name: "Fontara NDA", fileExtension: "pdf", documentId: "1" }],
    recipients: {
      signers: [
        {
          email: CONFIG.signerEmail,
          name: CONFIG.signerName,
          recipientId: "1", // unique to this envelope
          routingOrder: "1",
          tabs: { signHereTabs: [signHere] }, // tabs belong to the recipient
        },
      ],
    },
    status: draft ? "created" : "sent",
  };
}

/* ── 5 · send ────────────────────────────────────────────────────────────── */

async function sendEnvelope(session, envelope) {
  step(5, "Send it");
  line(dim("POST"), `${session.baseUri}/restapi/v2.1/accounts/{accountId}/envelopes`);
  const { status, data } = await api(session, "POST", "/envelopes", envelope);
  ok(`${status} Created · envelopeId ${maskId(data.envelopeId)} · status "${data.status}"`);
  return data.envelopeId;
}

/* ── status (polling while you build; Connect in production) ─────────────── */

async function envelopeStatus(session, envelopeId) {
  step("·", "Envelope status");
  line(dim("GET"), `${session.baseUri}/restapi/v2.1/accounts/{accountId}/envelopes/${maskId(envelopeId)}`);
  const { data } = await api(session, "GET", `/envelopes/${envelopeId}`);
  ok(`status "${data.status}"`);
  for (const [label, key] of [
    ["sent", "sentDateTime"],
    ["delivered", "deliveredDateTime"],
    ["completed", "completedDateTime"],
    ["declined", "declinedDateTime"],
    ["voided", "voidedDateTime"],
  ]) {
    if (data[key]) line(dim(label.padEnd(10)), new Date(data[key]).toLocaleString());
  }
  line(dim("Polling? Check each envelope no more often than every 20 minutes. In production, use Connect."));
}

/* ── session: kept for `npm run status`, never committed ─────────────────── */

async function loadSession() {
  try {
    const s = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    return s.expiresAt > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}
const saveSession = (s) => writeFile(SESSION_FILE, JSON.stringify(s, null, 2));

async function newSession() {
  const code = await signIn();
  const token = await exchangeCode(code);
  const account = await userInfo(token.accessToken);
  const session = { ...token, ...account };
  await saveSession(session);
  return session;
}

/* ── main ────────────────────────────────────────────────────────────────── */

function requireConfig(names) {
  const missing = names.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    console.error(red(`\nMissing in .env: ${missing.join(", ")}`));
    console.error(dim("Copy .env.example to .env and fill it in. See README.md."));
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [command = "send", envelopeArg] = args.filter((a) => !a.startsWith("--"));

  console.log(bold("\nDocusign eSignature REST API · send your first envelope"));

  if (command === "status") {
    requireConfig([
      ["DOCUSIGN_INTEGRATION_KEY", CONFIG.integrationKey],
      ["DOCUSIGN_SECRET_KEY", CONFIG.secretKey],
    ]);
    const session = (await loadSession()) ?? (await newSession());
    const id = envelopeArg ?? session.lastEnvelopeId;
    if (!id) throw new Error("no envelope yet: send one first, or pass its envelopeId");
    await envelopeStatus(session, id);
    return;
  }
  if (command !== "send") throw new Error(`unknown command "${command}" (use send or status)`);

  const options = { draft: flags.has("--draft"), absolute: flags.has("--absolute"), revised: flags.has("--revised") };

  if (flags.has("--dry-run")) {
    requireConfig([
      ["SIGNER_NAME", CONFIG.signerName],
      ["SIGNER_EMAIL", CONFIG.signerEmail],
    ]);
    const envelope = await buildEnvelope(options);
    envelope.documents[0].documentBase64 = `${envelope.documents[0].documentBase64.slice(0, 24)}…`;
    envelope.recipients.signers[0].email = maskEmail(envelope.recipients.signers[0].email);
    console.log(`\n${dim("The JSON body (documentBase64 shortened, the email masked):")}\n${JSON.stringify(envelope, null, 2)}`);
    return;
  }

  requireConfig([
    ["DOCUSIGN_INTEGRATION_KEY", CONFIG.integrationKey],
    ["DOCUSIGN_SECRET_KEY", CONFIG.secretKey],
    ["SIGNER_NAME", CONFIG.signerName],
    ["SIGNER_EMAIL", CONFIG.signerEmail],
  ]);
  const session = await newSession();
  const envelope = await buildEnvelope(options);
  const envelopeId = await sendEnvelope(session, envelope);
  await saveSession({ ...session, lastEnvelopeId: envelopeId });
  line(dim(options.draft ? "Find the draft in your developer account's Agreements page." : `${CONFIG.signerName} has an email from Docusign. Check its status: npm run status`));
}

main().catch((err) => {
  console.error(`\n${red("✗")} ${err.message}`);
  if (err instanceof ApiError && /ANCHOR/i.test(err.body?.errorCode ?? "")) {
    console.error(dim("  The anchor string wasn't found in the document. Check the anchor text first."));
  }
  process.exit(1);
});

/* ── the page the browser lands on ───────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function page(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #130032; color: #fff;
         font: 18px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-weight: 500; font-size: 2rem; margin: 0 0 .5rem; }
  p { color: #cbc2ff; margin: 0; }
  code { color: #fff; }
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}
