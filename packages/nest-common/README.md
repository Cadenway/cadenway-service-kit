# @waypoint/nest-common

Plumbing shared by the Waypoint NestJS services and gateways. It holds the health module today; the
rest of what the [repository instructions](../../AGENTS.md) list for this package is not
implemented yet.

`@nestjs/common`, `@nestjs/core`, `reflect-metadata` and `rxjs` are peer dependencies: the
application provides them.

## Health module

`HealthModule` adds two routes, built on `@nestjs/terminus`:

| Route               | Purpose                                             | Answer                    |
| ------------------- | --------------------------------------------------- | ------------------------- |
| `GET /health/live`  | The process is running. Checks nothing, on purpose. | 200 and the Terminus body |
| `GET /health/ready` | The application accepts requests.                   | 200 and the Terminus body |

The Terminus body of a healthy application is `{ "status": "ok", "info": {}, "error": {}, "details": {} }`.

```ts
import { Module } from '@nestjs/common';
import { HealthModule } from '@waypoint/nest-common';

@Module({ imports: [HealthModule] })
export class AppModule {}
```

### Options

None. Readiness runs no dependency indicator yet: it answers 200 as soon as the application
listens. Indicators are meant to arrive behind an option whose default keeps this behavior, so the
import above stays valid.
