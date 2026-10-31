---
name: service-api
description: Use the saved project-api connection when asked to work with that service's API.
---

Use the saved `project-api` connection for HTTP API requests:

```sh
t3-api project-api GET projects
printf '%s' '{"name":"demo-project"}' | t3-api project-api POST projects --stdin
```

Change the credential name and paths in this example to match your service. Paths
are relative to its saved base URL, without a leading slash. Authentication,
including the header or query parameter name, is configured in Setup →
Credentials. Do not read or print credential files. Use `--stdin` for JSON bodies.
