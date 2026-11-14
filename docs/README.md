# cadenway-service-kit documentation

cadenway-service-kit owns the three runtime packages shared by NestJS services and gateways.

## Current status

The checkout contains the runtime packages and their build and release workflows. See the package READMEs for implemented capabilities. The [`@cadenway/nest-testing` development package](https://github.com/Cadenway/cadenway-tooling/tree/main/packages/nest-testing) is maintained in cadenway-tooling.

## Read the guides

- [Architecture and ownership](architecture.md): boundaries and planned repository structure.
- [Hexagonal architecture for NestJS](hexagonal-architecture.md): module template, dependency rules and architecture checks.
- [Development and checks](development.md): prerequisites, commands and verification.
- [Domain and integration](integration.md): repository-specific contracts, behavior and dependencies.

## Sources and policy

- [Repository overview](../.github/README.md) and [contribution guide](../.github/CONTRIBUTING.md).
- [Repository instructions and hard limits](../AGENTS.md).
- [Claude Code instructions](../CLAUDE.md) and [tooling](../.claude/README.md).
- [Codex tooling](../.codex/README.md).
- [Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N).

Repository instructions take precedence over this summary. Refer to the actual package manifests, implementation, specifications, and workflows once they exist; do not infer a deployed feature from a target design.
