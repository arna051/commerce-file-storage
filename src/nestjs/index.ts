import {
  Inject,
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import { createFileStorage, type CreateFileStorageOptions, type FileStorage } from '../storage.js';

export const FILE_STORAGE = Symbol.for('commerce-file-storage:FileStorage');
export const InjectFileStorage = () => Inject(FILE_STORAGE);

export interface FileStorageModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  useFactory: (...args: unknown[]) => CreateFileStorageOptions | Promise<CreateFileStorageOptions>;
  global?: boolean;
}

@Module({})
export class FileStorageModule {
  static forRoot(options: CreateFileStorageOptions & { global?: boolean }): DynamicModule {
    const provider: Provider<FileStorage> = {
      provide: FILE_STORAGE,
      useFactory: () => createFileStorage(options),
    };
    return {
      module: FileStorageModule,
      global: options.global ?? false,
      providers: [provider],
      exports: [FILE_STORAGE],
    };
  }

  static forRootAsync(options: FileStorageModuleAsyncOptions): DynamicModule {
    const provider: Provider<FileStorage> = {
      provide: FILE_STORAGE,
      inject: options.inject ?? [],
      useFactory: async (...args: unknown[]) =>
        createFileStorage(await options.useFactory(...args)),
    };
    return {
      module: FileStorageModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers: [provider],
      exports: [FILE_STORAGE],
    };
  }
}

export type FileStorageModuleClass = Type<FileStorageModule>;
