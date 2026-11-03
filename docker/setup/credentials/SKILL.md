---
name: t3-vault
description: Saved passwords, tokens, API keys, SSH keys and other credentials on this server. Use this before asking the user for any secret, and whenever a task needs to sign in to a server, service, database, package registry or cloud account.
---

# Credentials on this server

Run `t3-vault list` before asking the user for a secret. Whatever is saved works for every agent, in every thread.

## Use what's saved

```sh
t3-vault list                          # what's saved, and the command to use each one
t3-vault run NAME -- COMMAND [ARG...]  # the command gets the secrets as environment variables
ssh NAME COMMAND                       # SSH servers saved with a key also work with scp and git
t3-vault ssh NAME -- COMMAND           # any saved SSH server, including ones with a password
t3-vault http NAME GET PATH            # for credentials saved with an API address
```

`t3-vault run` hides saved values in the command's output. That catches accidents, not intent, so never print a secret on purpose, and never read the files in `~/.t3/server-credentials`.

## When something is missing

1. Call `request_secret` with `delivery: "file"`. In `reason`, say what it's for, where to get it and the name you'll save it under. For example: "To deploy with wrangler. Create one at dash.cloudflare.com/profile/api-tokens with Workers edit access. I'll save it in your Vault as cloudflare-token, so no agent has to ask again."
2. Save it with `t3-vault add NAME --secret-file <file>`. This deletes T3's copy of the file. A recognized secret picks its own type, and `t3-vault types` lists the options. Add `--env VAR` for the variable name the tool expects, such as `CLOUDFLARE_API_TOKEN`.
3. Use it with the command that `add` prints.

If the user only wants it used once, use the file directly and skip saving it.

The card has a single-line box. Tokens, passwords, SSH keys and JSON key files fit. Kubeconfigs and `.env` files don't: run `t3-vault add NAME --type kubernetes` (or `--type file`), give the user the link it prints, then check with `t3-vault list`.

## When a saved secret is rejected

Ask with `request_secret` again, run `t3-vault replace NAME --secret-file <file>`, then retry.

## Adding an SSH server

Prefer keys, in this order:

1. **New key:** `t3-vault add NAME --host HOST --user USER --generate-key`. Show the user the line it prints to run on the server, then check with `t3-vault test NAME`.
2. **The user only has a password:** ask for it with `request_secret`, then run `t3-vault add NAME --host HOST --user USER --install-with-password-file <file>`. It prints the server's fingerprint. Show that to the user, and once they confirm it, run the same command with `--trust FINGERPRINT`. This installs a new key and doesn't keep the password.
3. **The user has a key:** `t3-vault add NAME --host HOST --user USER --key-file <file>`.
4. **The server doesn't allow keys:** `t3-vault add NAME --host HOST --user USER --password-file <file>`, then `t3-vault trust NAME` and follow what it prints.

If a server's key has changed, stop and show the user what `t3-vault trust NAME` prints. Never get past it with `StrictHostKeyChecking=no` or by editing a known_hosts file.
