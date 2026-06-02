# Core Resources

Resource discovery for reusable local assets.

```mermaid
flowchart LR
    Packages["packages.ts"] --> Prompts["prompt dirs"]
    Packages --> Skills["skill dirs"]
    Packages --> Extensions["extension entries"]
    Packages --> Themes["theme entries"]
    SkillsLoader["skills.ts"] --> Skills
```

| File | Purpose |
|---|---|
| [`packages.ts`](packages.ts) | Loads package manifests and resolves bundled prompts, skills, extensions, and themes |
| [`skills.ts`](skills.ts) | Loads skill definitions, command aliases, help text, and prompt expansion |

`@my-agent/cli` decides which resource directories to pass in from settings and package manifests. Core owns parsing and expansion.

