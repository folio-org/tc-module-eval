Status of this document: See [DR-000044 - Environment Variables](https://folio-org.atlassian.net/wiki/spaces/TC/pages/1400274946/DR-000044+-+Environment+Variables)

## 1. Purpose

This policy establishes standardized practices for environment variable management across all FOLIO backend modules, including edge modules, to provide consistent operational experience for system administrators and improve maintainability.

## 2. Naming Conventions

### 2.1 Standard Prefixes

All FOLIO modules MUST use the following standardized naming conventions:

| Category | Prefix/Suffix | Example |
| --- | --- | --- |
| Database | `DB_` | `DB_HOST`, `DB_PORT`, `DB_PASSWORD` |
| Kafka | `KAFKA_` | `KAFKA_HOST`, `KAFKA_PORT` |
| S3/Cloud Storage | `S3_` | `S3_URL`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` |
| Elasticsearch | `ELASTICSEARCH_` | `ELASTICSEARCH_URL`, `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD` |
| System User | `SYSTEM_USER_` | `SYSTEM_USER_PASSWORD`, `SYSTEM_USER_ENABLED` , `SYSTEM_USER_USERNAME` |
| Environment | `ENV` | `ENV=folio` |
| System Integration | `OKAPI_URL` | `OKAPI_URL` |
| Java Runtime | `JAVA_OPTIONS` | `JAVA_OPTIONS=-XX:MaxRAMPercentage=66.0` |
| Spring Framework | `SPRING_*`, `SERVER_*` | `SPRING_PROFILES_ACTIVE`, `SERVER_PORT` |
| Feature Flags | `*_ENABLED` | `SYSTEM_USER_ENABLED`, `ELASTICSEARCH_COMPRESSION_ENABLED` |

**Decision:** Use `S3_` prefix (not `AWS_`) for cloud storage variables to maintain vendor neutrality while indicating S3 API compatibility.

**Formatting Rule:** All environment variable names MUST be uppercase with underscores only (`[A-Z0-9]` and `_`). No dots/periods are permitted.

### 2.2 Framework-Specific Variables

Modules using common frameworks (Spring, RMB) inherit framework-specific environment variables. These do not need to be redocumented in module READMEs but should reference the framework documentation.

## 3. Documentation Requirements

### 3.1 Required Documentation Locations

All Environment variables declared by module developers MUST be documented in the following locations:

1. **ModuleDescriptor** (`descriptors/ModuleDescriptor-template.json`)

   * All environment variables with description field populated in the top-level `env` property of the ModuleDescriptor.
   * Serves as machine-readable source of truth
2. **ENV\_VARS.md** (or equivalent section in README.md)

   * Human-readable table format
   * Linked from README.md if separate file

**Note:** FOLIO DevOps will create automated tooling to read environment variable definitions from ModuleDescriptor and generate ENV\_VARS.md files, reducing manual documentation burden on module developers.

### 3.2 Required Documentation Fields

Each environment variable MUST include the following information:

| Field | Required | Format | Description |
| --- | --- | --- | --- |
| Name | Yes | Uppercase with underscores | Variable name following naming conventions |
| Default Value | Yes | String or empty string | Default value or empty string to indicate no default |
| Required | Yes | Boolean (true/false) | Whether variable must be set for module to function |
| Description | Yes | Text | Purpose, valid values, and behavior |

### 3.3 ModuleDescriptor Enhancement

Environment variables in ModuleDescriptor SHOULD include comprehensive description:

```
{
  "name": "S3_URL",
  "value": "http://127.0.0.1:9000/",
  "description": "S3-compatible storage endpoint URL",
  "required": true
}
```

## 4. Required vs. Optional Variables

### 4.1 Variable Classification

* **Required variables:** Module cannot function without them; no sensible default exists
* **Optional variables:** Module can function with default value or without the feature

**Principle:** If a variable has a default value in the module code, it is NOT a required variable.

### 4.2 Startup Behavior

Modules SHOULD implement the following behavior:

**For Required Variables:**

* Fail fast on startup with clear error message if missing or empty

**For Optional Variables:**

* Use documented default value

### 4.3 Clarification on Empty Values

* Empty strings for required variables SHOULD be treated as missing (throw error)

  + Exception: Boolean-like variables where presence/absence indicates true/false
  + Framework-specific behavior may override this for third-party libraries

## 5. Migration Strategy

### 5.1 For Existing Modules

**Dual Support Approach:**

Existing modules MUST add support for standardized environment variables alongside their existing non-compliant ones. The goal is to provide operators with a consistent experience while maintaining backward compatibility.

**Requirements:**

* Support both old (existing) and new (standardized) variable names
* No hard cutoff date for removing old variables - support both indefinitely or for an extended duration
* Implement variable precedence logic to handle cases where both old and new variables are set
* Document both variable names in ModuleDescriptor (DevOps automation will generate human-readable ENV\_VARS.md documentation)

**Variable Precedence:**  
When both old and new variables are set, modules SHOULD have standardized variables take precedence. e.g. If `S3_URL` is set, use it; otherwise fall back to `AWS_URL`.

### 5.2 For New Modules

All new modules MUST comply with this policy before acceptance into the FOLIO platform.

## 6. Observability Requirements (Optional but Recommended)

### 6.1 Startup Configuration Logging

Modules SHOULD log their configuration on startup at INFO level. **DO NOT LOG** sensitive info like passwords, api keys.

**Benefits:**

* Easier debugging of configuration issues
* Confirms which values are actually being used
* Validates environment variables were loaded correctly
* Helps identify missing or default values in production

## 7. Enforcement

### 7.1 New Module Acceptance

Compliance with this policy is required for new modules to be accepted into the FOLIO platform through the module evaluation process.

### 7.2 Existing Modules

* Development teams are encouraged to add standardized variable support during regular maintenance
* Updates should be made during major or minor version releases
* Compliance means adding support for standardized variables alongside existing ones (no requirement to remove old variables)
* Technical Council may establish specific milestones for when modules should add standardized variable support

### 7.3 Tooling Support

The DevOps team is requested to develop an automated tool to generate human-friendly documentation from ModuleDescriptors.

[FOLIO Module Evaluator](https://github.com/folio-org/tc-module-eval) will be updated to capture the intent of this document and provide automated analysis.
