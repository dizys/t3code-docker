# Server credentials

**Setup → Server credentials** keeps SSH passwords and API bearer tokens out
of skill files and agent prompts. Save a connection, then give the agent its
connection ID. The page supports adding, editing, testing and deleting connections
on desktop and phone, including inside T3 Code's Settings → Setup dialog.

Choose **Add connection**, enter a name and a stable ID such as `homeserver`,
then choose a type:

- **SSH password:** hostname or IP, username, port and password.
- **API bearer token:** the full API base URL and token. For Home Assistant,
  include `/api/`, for example `http://homeassistant.local/api/`.

Saved passwords and tokens are never returned to the browser. **Edit** changes
connection details and can replace the secret; leave the secret blank to keep
its existing value. A stale editor cannot overwrite changes from another
window: close it, reload the list, and reopen the connection before saving again.
Connection IDs and types stay fixed; create another entry to change them.

**Test** uses the saved login: SSH runs `true`, and API sends a GET to the saved
base URL. It returns only success or a short error, without the response body.
An API whose base URL does not accept GET may fail this test even when its token
works for other endpoints. SSH remembers a new host key on first use and refuses
a changed key. Verify first-use host identity on a trusted network.

## Use from an agent or terminal

Use the copy button beside a connection's command to paste it into a skill.
It copies only the helper command and connection ID. Replace the example remote
command or API path with the operation your skill needs.

These commands are installed in both image variants:

```sh
t3-ssh homeserver -- uptime
t3-ssh homeassistant-ssh -- 'ha core info'
t3-api homeassistant GET states/light.kitchen
printf '%s' '{"entity_id":"light.kitchen"}' |
  t3-api homeassistant POST services/light/turn_on --stdin
```

`t3-ssh` runs a non-interactive remote command. Supply a complete remote shell
command as one quoted argument when it includes pipelines or shell syntax. Its
stdin remains available for scripts, for example `t3-ssh homeserver -- bash -s`.
It uses password or keyboard-interactive authentication; multi-step challenges
and interactive terminal sessions are outside this helper's scope.

`t3-api` accepts GET, HEAD, POST, PUT, PATCH and DELETE. Paths are relative to the
saved base URL, without a leading slash. The optional `--stdin` supplies a JSON
body of at most 1 MiB. Requests stay under that base URL; redirects are refused
so a token cannot be forwarded to another destination. Responses go to stdout;
HTTP failures return a nonzero exit status. This helper covers REST calls, not
Home Assistant's websocket API.

Both helpers read their credentials internally, without including their values
in command arguments. Matching literal, JSON-escaped, URL-encoded and Base64
values are filtered from response output. This avoids accidental echoes of the
stored credential; it cannot recognize every possible transformation or prevent
an agent deliberately reading files with its shell.

## Move credentials out of skills

Create these three entries through the page:

| Connection ID | Type | Purpose |
| --- | --- | --- |
| `homeserver` | SSH password | HomeServer commands |
| `homeassistant-ssh` | SSH password | Home Assistant SSH commands |
| `homeassistant` | API bearer token | Home Assistant REST API |

Test each entry, then replace passwords and tokens in your skills with helper
commands. Example replacement skills are in
[`examples/skills`](../examples/skills). Keep any server-specific instructions
you still need. Install the image containing these helpers before switching
existing skills. Rotate credentials that previously appeared in chat or skill
history; deleting the text does not remove earlier copies.

## Storage and access

Connections are stored as plaintext JSON in
`$T3CODE_HOME/server-credentials/credentials.json` (normally
`/home/t3/.t3/server-credentials/credentials.json`). The directory is owner-only
(0700) and the file is owner-only (0600). The default `/home/t3` volume keeps
them across restarts, image upgrades and recreations. A deployment that mounts
only `T3CODE_HOME` keeps them there too. Protect backups of this volume.

The feature keeps credentials out of ordinary prompts and helper output. It is
not an encrypted vault or a permission boundary against an agent with shell
access. The authenticated console and helpers run as the same container user;
any process with that user's file access can read the saved values. SSH passes
the password to its askpass child through its private child environment.
Never request a credential dump in a chat or print that environment.

The page uses the existing setup authentication and request protections, and
requires HTTPS or a trusted private connection like the rest of the setup console.
It does not put secrets in `/status`, downloadable skills or browser storage.
