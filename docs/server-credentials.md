# Server credentials

**Setup → Server credentials** saves SSH passwords and API keys for servers,
internal tools and third-party services. Agents use a connection ID through
`t3-ssh` or `t3-api`, so the secret stays out of skill files and normal prompts.
The page supports adding, editing, testing and deleting connections on desktop
and phone, including inside T3 Code's Settings → Setup dialog.

Choose **Add connection**, enter a name and a stable ID such as `build-server`
or `project-api`, then choose a type:

- **SSH password:** hostname or IP, username, port and password.
- **API key or token:** the full API base URL, authentication settings and secret.
  Include any version or base path, such as `https://api.example.com/v1/`.

API connections support these authentication formats:

| Authentication | Settings | Request |
| --- | --- | --- |
| Bearer token | Saved token | `Authorization: Bearer <token>` |
| Custom header | Header name, optional value prefix | `X-API-Key: <key>`, `api-key: <key>`, or `Authorization: Token <key>` |
| Query parameter | Parameter name | `?api_key=<key>` or the name your service requires |

Choose the format required by the service. Query keys become part of the
request URL and may appear in the service's own logs; prefer headers when the
service supports them. OAuth sign-in flows, request signing and websocket
protocols are outside the HTTP helper's scope.

Saved passwords and keys are never returned to the credentials page. **Edit**
changes connection details or replaces the secret; leave the secret blank to
keep its saved value. A stale editor cannot overwrite another window's changes.
Close it, reload the list and reopen the connection before saving again.
Connection IDs and types stay fixed; create another entry to change them.
Existing API connections continue to use bearer authentication until edited.

## Test a connection

**Test** uses the saved login: SSH runs `true`, and API sends a GET to the saved
**Test path**. Use a relative endpoint that requires authentication, such as
`account` or `user`. A blank test path uses the base URL. Tests return success
or a short error without the response body. A public endpoint may succeed even
with an invalid key, and an endpoint that rejects GET cannot serve as this test.
SSH remembers a new host key on first use and refuses a changed key. Verify
first-use host identity on a trusted network.

## Use from a skill or terminal

Use the copy button beside a connection's command to paste it into a skill.
It copies only the helper command and connection ID. Replace the example remote
command or API path with the operation your skill needs.

These commands are installed in both image variants:

```sh
t3-ssh build-server -- uptime
t3-ssh staging-server -- 'systemctl status app'
t3-api project-api GET projects
printf '%s' '{"name":"demo-project"}' | t3-api project-api POST projects --stdin
```

`t3-ssh` runs a non-interactive remote command. Supply a complete remote shell
command as one quoted argument when it includes pipelines or shell syntax.
Stdin remains available for scripts, such as `t3-ssh build-server -- bash -s`.
The helper supports password or keyboard-interactive authentication, without
multi-step challenges or interactive terminal sessions.

`t3-api` accepts GET, HEAD, POST, PUT, PATCH and DELETE. Paths are relative to the
saved base URL, without a leading slash. Optional `--stdin` supplies a JSON body
of at most 1 MiB. Requests stay under the saved base URL and refuse redirects.
Responses go to stdout; HTTP failures return a nonzero exit status. The helper
injects the saved secret using the connection's authentication settings, so
commands stay the same when a service uses a different header or parameter.

Both helpers filter matching literal, JSON-escaped, URL-encoded and Base64
secret values from output. This covers accidental echoes of the saved value;
it cannot recognize every transformation or prevent an agent reading files
with its shell.

## Move credentials out of skills

Save and test each connection through the page, then replace secrets in your
skills with helper commands. Generic SSH and API skill templates are in
[`examples/skills`](../examples/skills); adapt their IDs and operations to your
services. Install the image containing the helpers before switching existing
skills. Rotate credentials that previously appeared in chat or skill history;
deleting the text does not remove earlier copies.

Home Assistant is one example of a bearer-token API: use your instance's API
base URL ending in `/api/` and choose Bearer token authentication. It uses the
same API connection type as other services.

## Storage and access

Connections are stored as plaintext JSON in
`$T3CODE_HOME/server-credentials/credentials.json` (normally
`/home/t3/.t3/server-credentials/credentials.json`). The directory is owner-only
(0700) and the file is owner-only (0600). The default `/home/t3` volume keeps
connections across restarts, image upgrades and recreations. Deployments that
mount only `T3CODE_HOME` keep them there too. Protect backups of this volume.

The feature keeps secrets out of ordinary prompts and helper output. It does
not encrypt the store or isolate it from an agent with shell access. The console
and helpers run as the same container user, so any process with that user's file
access can read the saved values. SSH passes the password to its askpass child
through a child environment. Never request a credential dump in chat or print
that environment.

The page uses the existing setup authentication and request protections. Use
HTTPS or a trusted private connection, as with the rest of the setup console.
Secrets are absent from `/status`, downloadable skills and browser storage.
