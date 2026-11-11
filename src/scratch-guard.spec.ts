import 'reflect-metadata';
import { appendFileSync } from 'node:fs';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

const OUT = 'D:/Temp/opencode/scratch-debug.txt';

@Injectable()
class ScratchGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(_context: ExecutionContext): boolean {
    return this.reflector !== undefined;
  }
}

@Controller('scratch')
@UseGuards(ScratchGuard)
class ScratchController {
  @Get()
  ping(): string {
    return 'pong';
  }
}

describe('scratch: guard with Reflector over HTTP', () => {
  it('responds 200', async () => {
    const builder = Test.createTestingModule({
      controllers: [ScratchController],
    });
    const compileError = await builder.compile().then(
      () => null,
      (error: unknown) => error,
    );
    const module = (builder as unknown as {
      compiledModule?: TestingModule;
    }) as never;

    let container: any;
    try {
      // The builder keeps its container on the instance.
      container = (builder as unknown as { container: any }).container;
    } catch {
      container = undefined;
    }

    const lines: string[] = [`compile error: ${String(compileError)}`];
    if (container) {
      const internalCore = container.getInternalCoreModuleRef();
      lines.push(`internal core module present: ${internalCore != null}`);
      if (internalCore) {
        lines.push(
          `internal core: id=${internalCore.id} isGlobal=${internalCore.isGlobal}`,
          `globalModules: ${container.globalModules
            .map((m: any) => m.metatype?.name ?? m.token)
            .join(', ')}`,
          `internal core providers (Reflector-ish): ${[
            ...internalCore.providers.keys(),
          ]
            .filter((k: any) => String(k).includes('Reflector'))
            .join(', ')}`,
          `internal core exports count: ${internalCore.exports.size}`,
        );
      }
      for (const moduleRef of container.getModules().values()) {
        lines.push(
          `module ${
            moduleRef.metatype?.name ?? moduleRef.token
          }: imports=[${[...moduleRef.imports]
            .map((m: any) => m.metatype?.name ?? String(m.token))
            .join(', ')}]`,
        );
      }
    } else {
      lines.push('no container access');
    }
    appendFileSync(OUT, lines.join('\n') + '\n', 'utf8');
    void module;

    if (compileError) {
      throw compileError;
    }
    expect(true).toBe(true);
  });
});
