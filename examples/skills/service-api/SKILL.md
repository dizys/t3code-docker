---
name: service-api
description: Use the saved project-api credential when asked to work with that service's API.
---

Call the API through the Vault, which adds the saved key:

```sh
t3-vault http project-api GET projects
printf '%s' '{"name":"demo-project"}' | t3-vault http project-api POST projects --stdin
```

Change the name and paths in this example to match your service. Paths are relative
to the saved API address, without a leading slash. For a tool that reads its token
from the environment, use `t3-vault run project-api -- <command>`. Don't read or
print credential files.
