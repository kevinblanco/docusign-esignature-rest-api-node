# Send your first envelope with the Docusign eSignature REST API

The sample from the tutorial video. It signs in with the Authorization Code
Grant, finds your account ID and base URI, and sends a PDF for signature in a
single POST request.

One file ([`send-envelope.js`](send-envelope.js)). No SDK and no dependencies:
just Node.js and `fetch`.

```
1  Sign in and approve access          Authorization Code Grant
2  Exchange the code for a token       POST /oauth/token
3  Your account ID and base URI        GET  /oauth/userinfo
4  Build the envelope definition       a PDF, a recipient, a tab, a status
5  Send it                             POST /restapi/v2.1/accounts/{accountId}/envelopes
```

## What you need

- **Node.js 20.12 or later.**
- **A Docusign developer account**, from
  [developers.docusign.com](https://developers.docusign.com). Everything runs in
  this sandbox, so nothing you send is legally binding.
- **An app with an integration key.** In your developer account, open
  **Apps and Keys**, choose **Add App and Integration Key**, and copy the
  integration key.
- **A secret key and a redirect URI on that app.**
  - When asked *"Is your application able to securely store a client
    secret?"*, choose **Yes**.
  - Add a secret key and copy it right away, because Docusign shows it only
    once.
  - Add the redirect URI `http://localhost:3001/callback`. It must match
    exactly.
- **An inbox you can open**, for the signer.

## Run it

```bash
cp .env.example .env    # then fill in your integration key, secret key and signer
npm start
```

What happens:
1. Your browser opens on Docusign's sign-in page. Sign in and approve access.
2. Docusign sends the browser back to `http://localhost:3001/callback` with a
   code, and the script takes it from there.
3. A few seconds later, the signer has an email from Docusign.

Check where the envelope is:

```bash
npm run status                 # the envelope you just sent
npm run status -- <envelopeId> # any envelope
```

## Options

| Command | What it does |
|---|---|
| `npm start -- --draft` | Sets `status` to `"created"`, so the envelope is saved as a draft and nothing is sent. Good while you're testing. |
| `npm start -- --dry-run` | Builds the envelope definition and prints the JSON body. Signs in to nothing and sends nothing. |
| `npm start -- --absolute` | Places the signature tab by x/y position instead of the anchor string. |
| `npm start -- --revised` | Sends a revised PDF with two more clauses, so its signature block sits lower. Run it with `--absolute` to see a fixed position miss; the anchor still finds the line. |
| `npm start -- --no-open` | Prints the sign-in URL instead of opening the browser. |
| `npm run pdfs` | Rebuilds the two sample PDFs in `documents/`. |

## How it works

**Authorization Code Grant.**
- You sign in once, and Docusign redirects to your redirect URI with a code.
- The code is valid for only two minutes, so the script exchanges it straight
  away. It sends the code with your integration key and secret key, and gets
  back an access token that lasts eight hours.
- The sign-in URL ends in `&prompt=login`, so you always sign in as the account
  you mean.
- If your code needs to run unattended, on a server with no one signing in,
  use the JWT Grant instead.

**account_id and base_uri come from `/oauth/userinfo`.**
- The script uses the account marked as default.
- `base_uri` depends on the environment: developer accounts resolve to
  `demo.docusign.net`, and production accounts route across different hosts.
- That's why there is no base URI in `.env`. A hard-coded one breaks when you
  move to production.

**The envelope is one JSON body**, built around four concepts:
- **Documents:** the PDF, read and base64-encoded straight into
  `documentBase64`. There is no separate upload.
- **Recipients:** a signer with an email, a name, and a `recipientId` that is
  unique to this envelope.
- **Tabs:** a Sign Here tab. Tabs belong to the recipient, not to the document.
- **Status:** `"sent"` sends the envelope as soon as it's posted; `"created"`
  saves it as a draft.

**The tab finds its place by anchor string.**
- The sample PDF has the marker `\s1\` on its signature line, in white text,
  so signers never see it. Docusign finds it and places the tab there.
- Fixed x/y positions break as soon as the text moves.
- Use a marker that appears nowhere else in the document.
- If the anchor isn't found, Docusign returns an error by default.

**Tracking.**
- Polling is fine while you build, as long as you check each envelope no more
  often than every 20 minutes.
- In production, use [Connect](https://developers.docusign.com/platform/webhooks/connect/),
  Docusign's webhooks.

**Rate limits.** Every API call backs off on `429 Too Many Requests`. It honours
`Retry-After`, or waits longer each time, instead of retrying rapidly.

## Going to production

1. Keep reading `base_uri` from userinfo (this script already does).
2. Take your integration key through
   [Go-Live](https://developers.docusign.com/platform/go-live/).
3. In production, add a secret key and redirect URIs again, because Go-Live
   doesn't copy them. Users approve access again there too.
4. Handle `429` with backoff.
5. Production agreements are legally binding, so keep test workflows in your
   developer account.
6. Point `DOCUSIGN_AUTH_SERVER` at `https://account.docusign.com`.

## Files

| File | What it is |
|---|---|
| `send-envelope.js` | The whole sample. |
| `.env.example` | The settings to copy into `.env`. |
| `documents/fontara-nda.pdf` | The PDF that gets sent, with `\s1\` hidden on its signature line. Fontara, Inc. is a fictitious company. |
| `documents/fontara-nda-revised.pdf` | The same agreement with two more clauses, for the anchor-vs-position comparison. |
| `tools/make-pdfs.js` | Builds both PDFs, with no dependencies. |

**Keep `.env` out of git.** It holds your secret key, and `.gitignore` already
excludes it, along with `.session.json`, where `npm run status` keeps your
access token between runs.

IDs in the output are masked like `18b4799a-xxxx-xxxx-xxxx-b5b4b8a97604`, so a
screen recording doesn't show them whole. Set `MASK_IDS=false` in `.env` to see
them in full.

## Resources

- [Authorization Code Grant](https://developers.docusign.com/platform/auth/authcode/)
- [Get an access token with Confidential Authorization Code Grant](https://developers.docusign.com/platform/auth/confidential-authcode-get-token/)
- [User info endpoint](https://developers.docusign.com/platform/auth/reference/user-info/)
- [eSignature concepts: envelopes, documents, recipients, tabs](https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/)
- [Auto-place (anchor) tabs](https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/tabs/auto-place/)
- [Go-Live](https://developers.docusign.com/platform/go-live/)
