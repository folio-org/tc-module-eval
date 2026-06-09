import { CommandNetworkPolicy } from '../types';

export const MAVEN_NETWORK_POLICY: CommandNetworkPolicy = {
  default: 'deny',
  allowedHosts: ['repo.maven.apache.org', 'repository.folio.org']
};

export const NPM_NETWORK_POLICY: CommandNetworkPolicy = {
  default: 'deny',
  allowedHosts: ['registry.yarnpkg.com', 'registry.npmjs.org', 'repository.folio.org']
};

export const GRADLE_NETWORK_POLICY: CommandNetworkPolicy = {
  default: 'deny',
  allowedHosts: ['repo.maven.apache.org', 'plugins.gradle.org', 'services.gradle.org', 'repository.folio.org']
};
