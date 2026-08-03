import path from 'node:path';
import type { ProjectPaths } from '../../src/environment';
import { buildProjectPaths, type PathScalarValues } from '../../src/environment/paths';
import { absolute } from './readers';

export interface ProjectPathsSpec {
  readonly root?: string;
  readonly contractsDirectory?: string;
  readonly contractsBuildDirectory?: string;
  readonly buildInfoDirectory?: string;
}

export function pathScalarValues(
  spec: ProjectPathsSpec = {},
): PathScalarValues {
  const root = spec.root ?? '/proj';
  return {
    working_directory: absolute(root),
    contracts_directory: absolute(
      spec.contractsDirectory ?? path.join(root, 'contracts'),
    ),
    contracts_build_directory: absolute(
      spec.contractsBuildDirectory ?? path.join(root, 'build', 'contracts'),
    ),
    build_info_directory: absolute(
      spec.buildInfoDirectory ?? path.join(root, 'build', 'build-info'),
    ),
  };
}

/**
 * A validated `ProjectPaths`, built through the production projection rather
 * than assembled by hand — so `contractsBuildDirectoryIsExternal` is *observed*
 * here exactly as it is in production (INV-3).
 */
export function projectPathsFixture(spec: ProjectPathsSpec = {}): ProjectPaths {
  return buildProjectPaths(pathScalarValues(spec));
}
