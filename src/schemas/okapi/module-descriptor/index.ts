import moduleDescriptor from './ModuleDescriptor.json';
import envEntry from './EnvEntry.json';
import envEntryList from './EnvEntryList.json';
import interfaceDescriptor from './InterfaceDescriptor.json';
import interfaceReference from './InterfaceReference.json';
import launchDescriptor from './LaunchDescriptor.json';
import permission from './Permission.json';
import routingEntry from './RoutingEntry.json';
import uiModuleDescriptor from './UiModuleDescriptor.json';

export const OKAPI_MODULE_DESCRIPTOR_SCHEMA_BASELINE =
  'folio-org/okapi master okapi-core/src/main/raml as retrieved 2026-06-08';

export const OKAPI_MODULE_DESCRIPTOR_SCHEMA_SOURCE =
  'https://raw.githubusercontent.com/folio-org/okapi/master/okapi-core/src/main/raml/ModuleDescriptor.json';

export const okapiModuleDescriptorSchemas = [
  moduleDescriptor,
  envEntry,
  envEntryList,
  interfaceDescriptor,
  interfaceReference,
  launchDescriptor,
  permission,
  routingEntry,
  uiModuleDescriptor
];

export const okapiModuleDescriptorRootSchema = moduleDescriptor;
